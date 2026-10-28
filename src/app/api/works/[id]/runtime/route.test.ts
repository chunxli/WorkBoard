import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), work: vi.fn(), run: vi.fn(), bridge: vi.fn(),
  snapshot: vi.fn(), reply: vi.fn(), mcp: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { findFirst: mocks.work }, run: { findFirst: mocks.run } } }));
vi.mock("@/lib/managed-runtime", () => ({ getManagedRuntime: mocks.bridge }));
import { GET, POST } from "./route";

const sessionId = "synthetic-session";
const params = { params: Promise.resolve({ id: "work" }) };
function get(runId = "run") { return GET(new NextRequest(`http://localhost/api/works/work/runtime?runId=${runId}`), params); }
function post(extra: object = {}, origin = "http://localhost") {
  return POST(new NextRequest("http://localhost/api/works/work/runtime", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ runId: "run", sessionId, action: "reply", reply: { kind: "permission", requestId: randomUUID(), approved: false }, ...extra }),
  }), params);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.work.mockResolvedValue({ id: "work", hostname: hostname(), status: "ACTIVE" });
  mocks.run.mockResolvedValue({ id: "run", hostname: hostname(), status: "RUNNING", trigger: "MANUAL", engine: "SDK", copilotSessionId: sessionId });
  mocks.bridge.mockReturnValue({ sessionId, snapshot: mocks.snapshot, reply: mocks.reply, mcpAction: mocks.mcp });
  mocks.snapshot.mockResolvedValue({ sessionId, requests: [], ready: true, mcp: [], mcpError: null, thirdPartyEnabled: null });
});

describe("owner-scoped live runtime controls", () => {
  it("requires authentication and scopes Work and Run lookups", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect(mocks.work).not.toHaveBeenCalled();
    expect((await get()).status).toBe(200);
    expect(mocks.work).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "work", userId: "owner" } }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "run", workId: "work", experimentVariantId: null } }));
    mocks.work.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
  });

  it("returns uncached safe state and dispatches explicit decisions", async () => {
    const response = await get();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ available: true, state: { sessionId } });
    expect((await post()).status).toBe(200);
    expect(mocks.reply).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
    const mcpRequest = new NextRequest("http://localhost/api/works/work/runtime", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run", sessionId, action: "mcp-tools", serverName: "native" }),
    });
    mocks.mcp.mockResolvedValue({ tools: ["synthetic-tool"] });
    expect(await (await POST(mcpRequest, params)).json()).toEqual({ tools: ["synthetic-tool"] });
    expect(mocks.mcp).toHaveBeenCalledExactlyOnceWith("mcp-tools", "native");
  });

  it("rejects foreign hosts, stale session IDs and changed runtime bindings", async () => {
    mocks.run.mockResolvedValueOnce({ id: "run", hostname: "other-host" });
    expect((await get()).status).toBe(409);
    expect((await post({ sessionId: "stale" })).status).toBe(409);
    mocks.bridge.mockReturnValueOnce({ sessionId: "changed" });
    expect((await post()).status).toBe(409);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it("reports a null-host queued Run as waiting and automatically exposes controls after startup", async () => {
    const queued = { id: "run", hostname: null, status: "PENDING", trigger: "WORK", engine: "SDK", copilotSessionId: sessionId };
    mocks.run.mockResolvedValue(queued);
    const waiting = await get();
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toMatchObject({ available: false, reason: expect.stringContaining("queued or starting") });
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect((await post()).status).toBe(409);
    expect(mocks.reply).not.toHaveBeenCalled();
    mocks.run.mockResolvedValue({ ...queued, hostname: hostname(), status: "RUNNING" });
    expect(await (await get()).json()).toMatchObject({ available: true, state: { ready: true } });
  });

  it("does not grant controls to a running session before its host or session is confirmed", async () => {
    const running = { id: "run", hostname: null, status: "RUNNING", trigger: "WORK", engine: "SDK", copilotSessionId: sessionId };
    mocks.run.mockResolvedValue(running);
    const waiting = await get();
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toMatchObject({ available: false, reason: expect.stringContaining("host has not been confirmed") });
    expect((await post()).status).toBe(409);
    expect(mocks.bridge).not.toHaveBeenCalled();
    mocks.run.mockResolvedValue({ ...running, hostname: hostname(), copilotSessionId: null });
    expect(await (await get()).json()).toMatchObject({ available: false, reason: expect.stringContaining("session to be assigned") });
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it("still rejects a known foreign Work or Run while queued and never relabels it as startup", async () => {
    const queued = { id: "run", hostname: null, status: "PENDING", trigger: "WORK", engine: "SDK", copilotSessionId: sessionId };
    mocks.run.mockResolvedValue(queued);
    mocks.work.mockResolvedValueOnce({ id: "work", hostname: "other-machine", status: "ACTIVE" });
    expect((await get()).status).toBe(409);
    mocks.run.mockResolvedValue({ ...queued, hostname: "other-machine" });
    expect((await get()).status).toBe(409);
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it("keeps Terminal-owned, archived and legacy Runs read-only", async () => {
    mocks.run.mockResolvedValueOnce({ id: "run", hostname: hostname(), status: "RUNNING", trigger: "TERMINAL_RESUME", engine: "CLI", copilotSessionId: sessionId });
    expect(await (await get()).json()).toMatchObject({ available: false, reason: expect.stringContaining("Terminal") });
    mocks.work.mockResolvedValueOnce({ id: "work", hostname: hostname(), status: "ARCHIVED" });
    expect((await post()).status).toBe(409);
    mocks.bridge.mockReturnValueOnce(undefined);
    expect((await post()).status).toBe(409);
    mocks.work.mockResolvedValueOnce({ id: "work", hostname: "other-machine", status: "ACTIVE" });
    expect((await post()).status).toBe(409);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it.each(["SUCCESS", "QUEUED", "CANCELLED"])("does not control %s Runs", async (status) => {
    mocks.run.mockResolvedValue({ id: "run", hostname: hostname(), status, engine: "SDK", trigger: "MANUAL", copilotSessionId: sessionId });
    expect(await (await get()).json()).toMatchObject({ available: false });
    expect((await post()).status).toBe(409);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it("rejects malformed, cross-origin and token-bearing actions before dispatch", async () => {
    expect((await post({}, "https://foreign.example")).status).toBe(403);
    expect((await post({ token: "must-not-be-accepted" })).status).toBe(400);
    expect((await post({ reply: { kind: "permission", requestId: randomUUID(), approved: "true" } })).status).toBe(400);
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "RUNNING", "SUCCESS"])("never exposes or dispatches SDK controls for a native CLI Run in %s", async (status) => {
    mocks.run.mockResolvedValue({ id: "run", hostname: hostname(), status, engine: "CLI", trigger: "WORK", copilotSessionId: sessionId });
    expect(await (await get()).json()).toMatchObject({ available: false, reason: expect.stringContaining("native non-interactive Copilot CLI") });
    expect((await post()).status).toBe(409);
    for (const action of ["mcp-tools", "mcp-login", "mcp-reload"]) {
      const request = new NextRequest("http://localhost/api/works/work/runtime", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: "run", sessionId, action, ...(action === "mcp-reload" ? {} : { serverName: "native" }) }),
      });
      expect((await POST(request, params)).status).toBe(409);
    }
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(mocks.mcp).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1:3100",
    "http://localhost:3100",
    "http://[::1]:3100",
    "https://work.example.test",
  ])("accepts same-origin MCP actions from %s despite Next URL normalization", async (origin) => {
    const request = new NextRequest(`${origin}/api/works/work/runtime`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Host: new URL(origin).host },
      body: JSON.stringify({ runId: "run", sessionId, action: "mcp-tools", serverName: "native" }),
    });
    mocks.mcp.mockResolvedValue({ tools: ["synthetic-tool"] });
    const response = await POST(request, params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tools: ["synthetic-tool"] });
    expect(mocks.mcp).toHaveBeenCalledExactlyOnceWith("mcp-tools", "native");
  });

  it.each([
    ["http://127.0.0.1:3100", "http://localhost:3100"],
    ["http://localhost:3100", "http://127.0.0.1:3100"],
    ["http://127.0.0.1:3100", "http://127.0.0.1:3101"],
    ["http://127.0.0.1:3100", "https://127.0.0.1:3100"],
    ["http://127.0.0.1:3100", "https://foreign.example"],
    ["http://127.0.0.1:3100", "null"],
  ])("rejects Origin %s / %s mismatches before reading runtime state", async (requestOrigin, origin) => {
    const request = new NextRequest(`${requestOrigin}/api/works/work/runtime`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Origin: origin, Host: new URL(requestOrigin).host,
        "X-Forwarded-Host": new URL(origin === "null" ? "https://foreign.example" : origin).host,
      },
      body: JSON.stringify({ runId: "run", sessionId, action: "mcp-reload" }),
    });
    expect((await POST(request, params)).status).toBe(403);
    expect(mocks.work).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.mcp).not.toHaveBeenCalled();
  });

  it("does not leak raw RPC errors or credentials", async () => {
    mocks.mcp.mockRejectedValue(new Error("Authorization: Bearer synthetic-secret"));
    const request = new NextRequest("http://localhost/api/works/work/runtime", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run", sessionId, action: "mcp-reload" }),
    });
    const response = await POST(request, params);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-secret");
  });
});
