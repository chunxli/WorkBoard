import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/caseiq-mcp-sessions", () => ({ listCaseIqMcpSessions: mocks.list }));
import { GET } from "./route";
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue("owner"); mocks.list.mockResolvedValue({ sessions: [] });
});
describe("owned MCP configuration index", () => {
  it("uses the signed-in user and never caches session metadata", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.list).toHaveBeenCalledWith("owner");
  });
  it("requires authentication before enumerating sessions", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
