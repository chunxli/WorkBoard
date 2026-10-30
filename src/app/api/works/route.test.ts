import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_EXECUTION_DEFAULTS } from "@/lib/execution-defaults";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), defaults: vi.fn(), provision: vi.fn(), create: vi.fn(), aggregate: vi.fn(),
  list: vi.fn(), reconcile: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/user-execution-defaults", () => ({ getUserExecutionDefaults: mocks.defaults }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { create: mocks.create, aggregate: mocks.aggregate, findMany: mocks.list } } }));
vi.mock("@/lib/work-directory-reconciler", () => ({ reconcileMissingWorkDirectories: mocks.reconcile }));
vi.mock("@/lib/repo-workdir", () => ({ resolveRepoWorkdir: vi.fn() }));
vi.mock("@/lib/work-files", () => ({
  provisionWorkDirectory: mocks.provision, unregisterWorkDirectory: vi.fn(), WorkFileError: class extends Error {},
}));
import { GET, POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.defaults.mockResolvedValue({ ...BUILT_IN_EXECUTION_DEFAULTS, defaultEngine: "SDK", model: "saved-model", permissionMode: "full" });
  mocks.provision.mockResolvedValue({ directoryPath: "C:\\synthetic", canonicalPath: "C:\\synthetic", promptFileName: "PROMPT.md", promptHash: "fixture" });
  mocks.aggregate.mockResolvedValue({ _min: { position: null } });
  mocks.create.mockImplementation(async ({ data }) => data);
  mocks.list.mockResolvedValue([]);
});

describe("Work listing auto-archive", () => {
  it.each(["", "?view=archived", "?view=all"])("reconciles the signed-in user's directories before listing %s", async (query) => {
    const response = await GET(new NextRequest(`http://localhost/api/works${query}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(mocks.reconcile).toHaveBeenCalledWith("owner");
    expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]);
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "owner" }),
    }));
  });

  it("does not scan or list directories for unauthenticated callers", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest("http://localhost/api/works"))).status).toBe(401);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
function create(extra: object = {}) {
  return POST(new NextRequest("http://localhost/api/works", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Synthetic work", directoryPath: "C:\\synthetic", prompt: "Synthetic task", ...extra }),
  }));
}

describe("new Work runtime defaults", () => {
  it("respects explicitly saved SDK defaults and preserves other settings", async () => {
    const response = await create();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ defaultEngine: "SDK", model: "saved-model", permissionMode: "full" });
  });

  it("uses built-in CLI defaults when no SDK override is saved", async () => {
    mocks.defaults.mockResolvedValueOnce(BUILT_IN_EXECUTION_DEFAULTS);
    expect(await (await create()).json()).toMatchObject({ defaultEngine: "CLI" });
  });

  it("uses an explicit CLI choice instead of a saved SDK default", async () => {
    expect(await (await create({ defaultEngine: "CLI" })).json()).toMatchObject({ defaultEngine: "CLI" });
  });

  it("retains explicit SDK API compatibility rather than rewriting the requested engine", async () => {
    expect(await (await create({ defaultEngine: "SDK" })).json()).toMatchObject({ defaultEngine: "SDK" });
  });

  it("does not create Work for unauthenticated callers", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await create()).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
