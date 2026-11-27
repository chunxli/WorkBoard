import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";

const mocks = vi.hoisted(() => ({ user: vi.fn(), local: vi.fn(), status: vi.fn(), start: vi.fn(), stopAndStart: vi.fn(), clean: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/local-terminal-policy", () => ({ localTerminalAvailable: mocks.local }));
vi.mock("@/lib/caseiq-authentication", () => ({
  getCaseIqAuthenticationStatus: mocks.status,
  startCaseIqAuthentication: mocks.start,
  stopCaseIqRunsAndStartAuthentication: mocks.stopAndStart,
  cleanCaseIqStaleCredentials: mocks.clean,
}));
import { GET, POST } from "./route";
const params = { params: Promise.resolve({ id: "work" }) };
const requestId = randomUUID();
function post(extra: object = {}, headers: Record<string, string> = {}) {
  return POST(new NextRequest("http://localhost/api/works/work/caseiq/auth", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: JSON.stringify({ runId: "run", requestId, ...extra }),
  }), params);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.local.mockReturnValue(true);
  mocks.status.mockResolvedValue({ available: true, blockedReason: null, authenticationVerified: false, operation: null });
  mocks.start.mockResolvedValue({ available: false, blockedReason: "Opening", authenticationVerified: false, operation: { id: requestId } });
});

describe("owned CaseIQ sign-in API", () => {
  it("requires website authentication before looking up or starting the native session", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/api/works/work/caseiq/auth?runId=run"), params)).status).toBe(401);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("provides uncached read-only state and delegates exact Work/Run ownership", async () => {
    const result = await GET(new NextRequest("http://localhost/api/works/work/caseiq/auth?runId=run"), params);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(mocks.status).toHaveBeenCalledWith("owner", "work", "run", true);
    expect(mocks.start).not.toHaveBeenCalled();
    const accepted = await post();
    expect(accepted.status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith("owner", "work", "run", requestId, false, false);
  });
  it("rejects non-local and cross-origin sign-in before any process action", async () => {
    mocks.local.mockReturnValueOnce(false);
    expect((await post()).status).toBe(403);
    expect((await post({}, { Origin: "https://another-host" })).status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("forwards automatic sign-in intent and explicit exact-folder trust through the same guarded action", async () => {
    expect((await post({ automatic: true, trustWorkFolder: true })).status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith("owner", "work", "run", requestId, true, true);
    expect((await post({ automatic: "yes" })).status).toBe(400);
  });
  it("rejects malformed IDs, unsupported content types and arbitrary MCP/token/prompt fields", async () => {
    expect((await post({ requestId: "invalid" })).status).toBe(400);
    expect((await post({ prompt: "must not execute", serverName: "another-mcp" })).status).toBe(400);
    expect((await post({}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await GET(new NextRequest("http://localhost/api/works/work/caseiq/auth"), params)).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("reports owner/installation rejection without turning it into successful authentication", async () => {
    mocks.start.mockRejectedValueOnce(new CaseIqIntegrationError("The original binding is unavailable.", 409));
    const result = await post();
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "The original binding is unavailable." });
  });
  it("supports guarded local cleanup of stale Copilot MCP credentials without starting a Terminal", async () => {
    mocks.clean.mockResolvedValueOnce({
      available: true,
      blockedReason: null,
      authenticationVerified: false,
      operation: null,
      credentialCleanup: {
        deletedCount: 12,
        freedBytes: 24576,
        remainingCount: 20,
        remainingBytes: 12000,
        remainingStaleCopilotCount: 0,
        remainingStaleCopilotBytes: 0,
        staleMaxAgeDays: 7,
      },
    });
    const response = await POST(new NextRequest("http://localhost/api/works/work/caseiq/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ runId: "run", action: "clean-credentials" }),
    }), params);
    expect(response.status).toBe(200);
    expect(mocks.clean).toHaveBeenCalledWith("owner", "work", "run");
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("dispatches stop-and-sign-in with exact Work/Run ownership and folder-trust preference", async () => {
    mocks.stopAndStart.mockResolvedValueOnce({
      available: false,
      blockedReason: "Opening",
      authenticationVerified: false,
      operation: { id: requestId },
    });
    const response = await POST(new NextRequest("http://localhost/api/works/work/caseiq/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ action: "stop-and-sign-in", runId: "run", requestId, trustWorkFolder: true }),
    }), params);
    expect(response.status).toBe(202);
    expect(mocks.stopAndStart).toHaveBeenCalledWith("owner", "work", "run", requestId, true);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
