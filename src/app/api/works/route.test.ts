import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_EXECUTION_DEFAULTS } from "@/lib/execution-defaults";

const mocks = vi.hoisted(() => ({ user: vi.fn(), defaults: vi.fn(), provision: vi.fn(), create: vi.fn(), aggregate: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/user-execution-defaults", () => ({ getUserExecutionDefaults: mocks.defaults }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { create: mocks.create, aggregate: mocks.aggregate } } }));
vi.mock("@/lib/repo-workdir", () => ({ resolveRepoWorkdir: vi.fn() }));
vi.mock("@/lib/work-files", () => ({
  provisionWorkDirectory: mocks.provision, unregisterWorkDirectory: vi.fn(), WorkFileError: class extends Error {},
}));
import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.defaults.mockResolvedValue({ ...BUILT_IN_EXECUTION_DEFAULTS, defaultEngine: "SDK", model: "saved-model", permissionMode: "full" });
  mocks.provision.mockResolvedValue({ directoryPath: "C:\\synthetic", canonicalPath: "C:\\synthetic", promptFileName: "PROMPT.md", promptHash: "fixture" });
  mocks.aggregate.mockResolvedValue({ _min: { position: null } });
  mocks.create.mockImplementation(async ({ data }) => data);
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
