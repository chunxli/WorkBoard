import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseIqMcpDefaults } from "@/lib/caseiq-options";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), local: vi.fn(), read: vi.fn(), write: vi.fn(), discover: vi.fn(), ensure: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/local-terminal-policy", () => ({ localTerminalAvailable: mocks.local }));
vi.mock("@/lib/caseiq-integration", () => ({ ensurePrivateRuntimeDirectory: mocks.ensure }));
vi.mock("@/lib/caseiq-mcp-defaults-state", () => ({
  readCaseIqMcpDefaults: mocks.read, writeCaseIqMcpDefaults: mocks.write,
  caseIqMcpDefaultsDirectory: () => "C:\\synthetic-private\\mcp-defaults",
}));
vi.mock("@/lib/caseiq-mcp-sessions", () => ({ discoverCaseIqMcpServers: mocks.discover }));
import { GET, PUT } from "./route";
let stored: CaseIqMcpDefaults;
function put(extra: object = {}, headers: Record<string, string> = {}) {
  return PUT(new NextRequest("http://localhost/api/caseiq/mcp-defaults", {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: JSON.stringify({ defaultAutoApprove: false, servers: [], ...extra }),
  }));
}
beforeEach(() => {
  vi.resetAllMocks(); stored = { defaultAutoApprove: true, servers: [] };
  mocks.user.mockResolvedValue("owner"); mocks.local.mockReturnValue(true);
  mocks.read.mockImplementation(async () => stored);
  mocks.write.mockImplementation(async (_userId: string, value: CaseIqMcpDefaults) => { stored = value; });
  mocks.discover.mockResolvedValue({ serverNames: ["SupportIQ", "safewright"], warnings: [] });
  mocks.ensure.mockResolvedValue(undefined);
});
describe("user/host MCP defaults API", () => {
  it("requires authentication and returns uncached discovered defaults", async () => {
    const result = await GET(new NextRequest("http://localhost/api/caseiq/mcp-defaults"));
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect((await result.json()).settings.defaultAutoApprove).toBe(true);
    mocks.user.mockResolvedValue(null);
    expect((await put()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/api/caseiq/mcp-defaults"))).status).toBe(401);
  });
  it("saves initial defaults without changing Work/session configuration", async () => {
    const response = await put({ servers: [{ serverName: "safewright", autoApprove: true }] });
    expect(response.status).toBe(200);
    expect(mocks.write).toHaveBeenCalledWith("owner", { defaultAutoApprove: false, servers: [{ serverName: "safewright", autoApprove: true }] });
    expect(mocks.ensure).toHaveBeenCalledWith("C:\\synthetic-private\\mcp-defaults");
  });
  it("rejects foreign origins, remote writes and arbitrary server configuration", async () => {
    expect((await put({}, { Origin: "https://another-host" })).status).toBe(403);
    mocks.local.mockReturnValueOnce(false);
    expect((await put()).status).toBe(403);
    expect((await put({}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await put({ servers: [{ serverName: "UnknownMCP", autoApprove: true }] })).status).toBe(400);
    expect((await put({ servers: [{ serverName: "shell", autoApprove: true }] })).status).toBe(400);
    expect((await put({ endpoint: "https://not-allowed.invalid" })).status).toBe(400);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
