import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(), start: vi.fn(), models: vi.fn(), stop: vi.fn(), forceStop: vi.fn(),
  create: vi.fn(), send: vi.fn(), options: [] as unknown[],
}));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("@/lib/copilot-cli-executable", () => ({ resolveCopilotCliExecutable: () => "C:\\synthetic\\copilot.exe" }));
vi.mock("@/lib/copilot-runner", () => ({ buildCopilotEnvironment: () => ({ NODE_ENV: "production" }) }));
vi.mock("@github/copilot-sdk", () => ({
  RuntimeConnection: { forStdio: (options: object) => ({ kind: "stdio", ...options }) },
  CopilotClient: class {
    constructor(options: unknown) { mocks.options.push(options); }
    start = mocks.start; listModels = mocks.models; stop = mocks.stop; forceStop = mocks.forceStop;
    createSession = mocks.create; send = mocks.send;
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.options.length = 0;
  mocks.exec.mockImplementation((_file, _args, _options, callback) =>
    callback(null, '`model`: "available", "blocked", "missing"\n`other`: "ignored"', ""));
  mocks.models.mockResolvedValue([{ id: "available", policy: { state: "enabled" } }, { id: "blocked", policy: { state: "disabled" } }]);
  mocks.stop.mockResolvedValue([]);
  mocks.forceStop.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("non-billable account model catalog", () => {
  it("coalesces requests, verifies account policy and never creates inference sessions", async () => {
    const { getCopilotModelCatalog } = await import("./copilot-models");
    const [first, second] = await Promise.all([getCopilotModelCatalog(), getCopilotModelCatalog()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ verified: true, models: ["available"] });
    expect(first.modelOptions.find((model) => model.id === "missing")?.availability).toBe("unavailable");
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.models).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.options[0]).toMatchObject({ connection: { kind: "stdio", path: "C:\\synthetic\\copilot.exe" } });
  });

  it("caches briefly, supports force refresh, and refreshes after expiry", async () => {
    vi.useFakeTimers();
    const { getCopilotModelCatalog } = await import("./copilot-models");
    await getCopilotModelCatalog();
    await getCopilotModelCatalog();
    expect(mocks.models).toHaveBeenCalledOnce();
    await getCopilotModelCatalog(true);
    expect(mocks.models).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60001);
    await getCopilotModelCatalog();
    expect(mocks.models).toHaveBeenCalledTimes(3);
    expect(mocks.exec).toHaveBeenCalledOnce();
  });

  it("reports failed verification explicitly while retaining unverified candidate IDs", async () => {
    mocks.models.mockRejectedValue(new Error("synthetic private authentication details"));
    const { getCopilotModelCatalog } = await import("./copilot-models");
    const catalog = await getCopilotModelCatalog();
    expect(catalog).toMatchObject({ verified: false, models: ["available", "blocked", "missing"] });
    expect(catalog.modelOptions.every((model) => model.availability === "unverified")).toBe(true);
    expect(catalog.error).toContain("Could not verify");
    expect(JSON.stringify(catalog)).not.toContain("private authentication");
    expect(console.error).toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("uses account models if CLI help fails instead of failing a verified catalog", async () => {
    mocks.exec.mockImplementation((_file, _args, _options, callback) => callback(new Error("CLI help failed"), "", ""));
    const { getCopilotModelCatalog } = await import("./copilot-models");
    expect(await getCopilotModelCatalog()).toMatchObject({ verified: true, models: ["available"], warning: expect.any(String) });
  });

  it("forces cleanup and does not report successful verification after shutdown errors", async () => {
    mocks.stop.mockResolvedValue([new Error("synthetic shutdown failure")]);
    const { getCopilotModelCatalog } = await import("./copilot-models");
    expect((await getCopilotModelCatalog()).verified).toBe(false);
    expect(mocks.forceStop).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not reuse a formerly valid cache after a failed forced refresh", async () => {
    const { getCopilotModelCatalog } = await import("./copilot-models");
    await getCopilotModelCatalog();
    mocks.models.mockRejectedValueOnce(new Error("synthetic network failure"));
    expect((await getCopilotModelCatalog(true)).verified).toBe(false);
    expect((await getCopilotModelCatalog()).verified).toBe(true);
    expect(mocks.models).toHaveBeenCalledTimes(3);
  });

  it("times out an unresponsive account lookup and still stops its metadata runtime", async () => {
    vi.useFakeTimers();
    mocks.models.mockReturnValue(new Promise(() => {}));
    const { getCopilotModelCatalog } = await import("./copilot-models");
    const request = getCopilotModelCatalog();
    await vi.advanceTimersByTimeAsync(20001);
    expect(await request).toMatchObject({ verified: false, error: expect.stringContaining("Could not verify") });
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("force-stops a metadata runtime whose normal shutdown hangs", async () => {
    vi.useFakeTimers();
    mocks.stop.mockReturnValue(new Promise(() => {}));
    const { getCopilotModelCatalog } = await import("./copilot-models");
    const request = getCopilotModelCatalog();
    await vi.advanceTimersByTimeAsync(5001);
    expect((await request).verified).toBe(false);
    expect(mocks.forceStop).toHaveBeenCalledOnce();
  });
});
