import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";

const mocks = vi.hoisted(() => ({ user: vi.fn(), local: vi.fn(), status: vi.fn(), single: vi.fn(), bulk: vi.fn(), automatic: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/local-terminal-policy", () => ({ localTerminalAvailable: mocks.local }));
vi.mock("@/lib/caseiq-tool-permissions", () => ({
  getCaseIqMcpPermissionStatus: mocks.status, setCaseIqMcpToolPermission: mocks.single,
  approveCaseIqMcpRequestedTools: mocks.bulk, setCaseIqMcpAutomaticApproval: mocks.automatic,
}));
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ id: "work" }) };
function post(extra: object = {}, headers: Record<string, string> = {}) {
  return POST(new NextRequest("http://localhost/api/works/work/caseiq/mcp-permissions", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: JSON.stringify("action" in extra
      ? { runId: "run", serverName: "safewright", ...extra }
      : { runId: "run", serverName: "safewright", toolName: "browser_snapshot", approved: true, ...extra }),
  }), context);
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue("owner"); mocks.local.mockReturnValue(true);
  mocks.status.mockResolvedValue({ servers: [] }); mocks.single.mockResolvedValue({ servers: [] });
  mocks.bulk.mockResolvedValue({ servers: [] }); mocks.automatic.mockResolvedValue({ servers: [] });
});
describe("scoped multi-MCP approval API", () => {
  it("requires website authentication before any state or permission access", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/api/works/work/caseiq/mcp-permissions?runId=run"), context)).status).toBe(401);
    expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.single).not.toHaveBeenCalled();
  });
  it("returns uncached aggregate metadata and passes the selected server unchanged", async () => {
    const result = await GET(new NextRequest("http://localhost/api/works/work/caseiq/mcp-permissions?runId=run"), context);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(mocks.status).toHaveBeenCalledWith("owner", "work", "run", true);
    expect((await post()).status).toBe(200);
    expect(mocks.single).toHaveBeenCalledWith("owner", "work", "run", "safewright", "browser_snapshot", true);
    expect((await post({ action: "approve-requested", toolNames: ["browser_snapshot"] })).status).toBe(200);
    expect(mocks.bulk).toHaveBeenCalledWith("owner", "work", "run", "safewright", ["browser_snapshot"]);
    expect((await post({ action: "set-automatic", enabled: true })).status).toBe(200);
    expect(mocks.automatic).toHaveBeenCalledWith("owner", "work", "run", "safewright", true);
  });
  it("rejects built-in permission kinds, selectors, arbitrary URLs/commands and mixed actions", async () => {
    for (const extra of [
      { serverName: "shell" }, { serverName: "read" }, { serverName: "custom-tool" }, { serverName: "MCP(*)" },
      { toolName: "*" }, { endpoint: "https://not-allowed.invalid" }, { command: "must-not-run" },
      { action: "set-automatic", enabled: true, toolName: "browser_snapshot" },
      { action: "approve-requested", toolNames: [] },
    ]) expect((await post(extra)).status).toBe(400);
    expect(mocks.single).not.toHaveBeenCalled(); expect(mocks.automatic).not.toHaveBeenCalled(); expect(mocks.bulk).not.toHaveBeenCalled();
  });
  it("keeps same-origin/local-host and content-type requirements", async () => {
    expect((await post({}, { Origin: "https://another-host" })).status).toBe(403);
    mocks.local.mockReturnValueOnce(false);
    expect((await post()).status).toBe(403);
    expect((await post({}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(mocks.single).not.toHaveBeenCalled();
  });
  it("preserves explicit native ownership and organization restrictions", async () => {
    mocks.single.mockRejectedValueOnce(new CaseIqIntegrationError("Organization approval is required.", 409));
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Organization approval is required." });
  });
});
