import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
const mocks = vi.hoisted(() => ({ user: vi.fn(), local: vi.fn(), status: vi.fn(), decision: vi.fn(), bulk: vi.fn(), automatic: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/local-terminal-policy", () => ({ localTerminalAvailable: mocks.local }));
vi.mock("@/lib/caseiq-tool-permissions", () => ({
  getCaseIqToolPermissionStatus: mocks.status, setCaseIqToolPermission: mocks.decision,
  approveCaseIqRequestedTools: mocks.bulk, setCaseIqAutomaticToolApproval: mocks.automatic,
}));
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ id: "work" }) };
function post(extra: object = {}, headers: Record<string, string> = {}) {
  return POST(new NextRequest("http://localhost/api/works/work/caseiq/tool-permissions", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: JSON.stringify("action" in extra ? { runId: "run", ...extra } : { runId: "run", toolName: "case_get", approved: true, ...extra }),
  }), context);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.local.mockReturnValue(true);
  mocks.status.mockResolvedValue({ tools: [] });
  mocks.decision.mockResolvedValue({ tools: [{ name: "case_get", approved: true }] });
  mocks.bulk.mockResolvedValue({ tools: [{ name: "case_get", approved: true }] });
  mocks.automatic.mockResolvedValue({ tools: [], autoApproveSupportIq: true });
});
describe("explicit Work/session tool approval API", () => {
  it("requires website authentication", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/api/works/work/caseiq/tool-permissions?runId=run"), context)).status).toBe(401);
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  it("reads uncached state and applies only an exact tool decision, never a task Prompt", async () => {
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq/tool-permissions?runId=run"), context);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.status).toHaveBeenCalledWith("owner", "work", "run", true);
    expect((await post()).status).toBe(200);
    expect(mocks.decision).toHaveBeenCalledWith("owner", "work", "run", "case_get", true);
  });
  it("rejects cross-origin, non-local, invalid content types and arbitrary privilege fields", async () => {
    expect((await post({}, { Origin: "https://another-host" })).status).toBe(403);
    mocks.local.mockReturnValueOnce(false);
    expect((await post()).status).toBe(403);
    expect((await post({}, { "Content-Type": "text/plain" })).status).toBe(415);
    for (const extra of [{ toolName: "*" }, { toolName: "SupportIQ(case_get)" }, { prompt: "must not run" }, { serverName: "OtherMCP" }, { allowAll: true }]) {
      expect((await post(extra)).status).toBe(400);
    }
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  it("preserves explicit ownership/organization rejections", async () => {
    mocks.decision.mockRejectedValueOnce(new CaseIqIntegrationError("Organization approval required.", 409));
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Organization approval required." });
  });
  it("delegates exact bulk snapshots and explicit true/false automatic decisions", async () => {
    expect((await post({ action: "approve-requested", toolNames: ["case_get", "get_case_notes"] })).status).toBe(200);
    expect(mocks.bulk).toHaveBeenCalledWith("owner", "work", "run", ["case_get", "get_case_notes"]);
    expect((await post({ action: "set-automatic", enabled: true })).status).toBe(200);
    expect((await post({ action: "set-automatic", enabled: false })).status).toBe(200);
    expect(mocks.automatic).toHaveBeenNthCalledWith(1, "owner", "work", "run", true);
    expect(mocks.automatic).toHaveBeenNthCalledWith(2, "owner", "work", "run", false);
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  it("rejects empty/duplicated/wildcard bulk snapshots and arbitrary automatic-approval servers", async () => {
    for (const extra of [
      { action: "approve-requested", toolNames: [] },
      { action: "approve-requested", toolNames: ["case_get", "case_get"] },
      { action: "approve-requested", toolNames: ["*"] },
      { action: "set-automatic", enabled: "true" },
      { action: "set-automatic", enabled: true, serverName: "OtherMCP" },
      { action: "set-automatic", enabled: true, approved: true },
    ]) expect((await post(extra)).status).toBe(400);
    expect(mocks.bulk).not.toHaveBeenCalled();
    expect(mocks.automatic).not.toHaveBeenCalled();
    expect((await post({ action: "set-automatic", enabled: true }, { Origin: "https://another-host" })).status).toBe(403);
  });
});
