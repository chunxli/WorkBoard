import { describe, expect, it, vi } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import { ManagedRuntime } from "./managed-runtime";
import { runtimeReplySchema, safeRuntimeUrl } from "./managed-runtime-types";

describe("managed runtime interactions", () => {
  it("waits for a real approval in standard scope and rejects stale replies", async () => {
    const runtime = new ManagedRuntime("session", false);
    const answer = runtime.onPermissionRequest({ kind: "read", path: "C:\\fixture", intention: "Read fixture" }, { sessionId: "session" });
    const [request] = (await runtime.snapshot()).requests;
    expect(request.kind).toBe("permission");
    const reply = { kind: "permission", requestId: request.id, approved: true } as const;
    runtime.reply(reply);
    expect(await answer).toEqual({ kind: "approve-once" });
    expect(() => runtime.reply(reply)).toThrow("expired");
  });

  it("preserves full scope without auto-approving managed policy requests", async () => {
    const runtime = new ManagedRuntime("session", true);
    const request = { kind: "read", path: "C:\\fixture", intention: "Read fixture" } as const;
    expect(await runtime.onPermissionRequest(request, { sessionId: "session" })).toEqual({ kind: "approve-once" });
    const managed = runtime.onPermissionRequest({ ...request, managedApprovalRequired: true }, { sessionId: "session" });
    expect((await runtime.snapshot()).requests[0]).toMatchObject({ kind: "permission", managed: true });
    runtime.cancelPending();
    expect(await managed).toEqual({ kind: "denied-no-approval-rule-and-could-not-request-from-user" });
  });

  it("validates questions and cancels pending requests when a session closes", async () => {
    const runtime = new ManagedRuntime("session", false);
    const answer = runtime.onUserInputRequest({ question: "Choose", choices: ["A", "B"], allowFreeform: false }, { sessionId: "session" });
    const [request] = (await runtime.snapshot()).requests;
    expect(() => runtime.reply({ kind: "question", requestId: request.id, answer: "C" })).toThrow("offered");
    runtime.reply({ kind: "question", requestId: request.id, answer: "B" });
    expect(await answer).toEqual({ answer: "B", wasFreeform: false });
    const pending = runtime.onUserInputRequest({ question: "Next?" }, { sessionId: "session" });
    const rejected = expect(pending).rejects.toThrow("ended");
    runtime.close();
    await rejected;
    expect((await runtime.snapshot()).requests).toEqual([]);
  });

  it.each(["javascript:alert(1)", "http://example.com", "https://user:password@example.com", "not a URL"])("rejects unsafe login URL %s", (url) => {
    expect(() => safeRuntimeUrl(url)).toThrow();
  });

  it("permits native HTTPS and loopback OAuth and rejects invalid response shapes", () => {
    expect(safeRuntimeUrl("https://example.com/login")).toBe("https://example.com/login");
    expect(safeRuntimeUrl("http://127.0.0.1:1234/callback")).toContain("127.0.0.1");
    expect(runtimeReplySchema.safeParse({ kind: "permission", requestId: "wrong", approved: "true" }).success).toBe(false);
  });

  it("validates all primitive form types before delivering a response", async () => {
    const runtime = new ManagedRuntime("session", false);
    const answer = runtime.onElicitationRequest({
      sessionId: "session", message: "Synthetic form", mode: "form",
      requestedSchema: {
        type: "object", required: ["name", "count", "enabled", "tags"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 5 },
          count: { type: "integer", minimum: 1, maximum: 3 },
          enabled: { type: "boolean" },
          tags: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "a", title: "A" }] } },
          choice: { type: "string", oneOf: [{ const: "one", title: "One" }] },
          enum: { type: "string", enum: ["ok"] },
          date: { type: "string", format: "date" },
          email: { type: "string", format: "email" },
          uri: { type: "string", format: "uri" },
          time: { type: "string", format: "date-time" },
        },
      },
    });
    const id = (await runtime.snapshot()).requests[0].id;
    const content = { name: "test", count: 2, enabled: false, tags: ["a"] };
    for (const invalid of [{}, { ...content, count: 1.5 }, { ...content, count: 4 }, { ...content, tags: ["a", "a"] },
      { ...content, extra: true }, { ...content, date: "2026-02-31" }, { ...content, choice: "two" },
      { ...content, enum: "no" }, { ...content, email: "wrong" }, { ...content, uri: "not a URL" }, { ...content, time: "2026-01-01" }]) {
      expect(() => runtime.reply({ kind: "elicitation", requestId: id, action: "accept", content: invalid })).toThrow();
    }
    runtime.reply({ kind: "elicitation", requestId: id, action: "accept", content });
    expect(await answer).toEqual({ action: "accept", content });
  });

  it("supports URL elicitation and cancels forms when switching sessions", async () => {
    const runtime = new ManagedRuntime("session", false);
    const answer = runtime.onElicitationRequest({ sessionId: "session", message: "Sign in", mode: "url", url: "https://example.com/sign-in" });
    const [request] = (await runtime.snapshot()).requests;
    expect(request).toMatchObject({ kind: "url", url: "https://example.com/sign-in" });
    expect(() => runtime.reply({ kind: "elicitation", requestId: request.id, action: "accept", content: { token: "not accepted" } })).toThrow("does not accept");
    runtime.unbind();
    expect(await answer).toEqual({ action: "cancel" });
    expect(() => runtime.reply({ kind: "elicitation", requestId: request.id, action: "accept" })).toThrow("expired");
    await expect(runtime.onElicitationRequest({ sessionId: "session", message: "Unsafe", mode: "url", url: "javascript:alert(1)" })).rejects.toThrow("unsafe");
    await expect(runtime.onElicitationRequest({ sessionId: "session", message: "Missing form" })).rejects.toThrow("schema");
  });

  it("does not include URL credentials or query secrets in permission previews", async () => {
    const runtime = new ManagedRuntime("session", false);
    const pending = runtime.onPermissionRequest({ kind: "url", url: "https://user:password@example.com/path?token=synthetic-secret", intention: "Fetch" }, { sessionId: "session" });
    expect((await runtime.snapshot()).requests[0]).toMatchObject({ detail: "https://example.com/path" });
    runtime.close();
    await pending;
  });
});

type McpState = Awaited<ReturnType<CopilotSession["rpc"]["mcp"]["list"]>>;
function mcpHarness(nativeMcpSignIn = true) {
  const state: McpState = {
    servers: [{ name: "native", status: "connected", error: "Authorization: Bearer synthetic-secret" }],
    host: {
      mcp3pEnabled: true, clients: ["native"], pendingConnections: ["pending"], disabledServers: ["disabled"], filteredServers: ["filtered"],
      failedServers: { broken: { message: "Bearer synthetic-secret", timestamp: 1 } }, needsAuthServers: { oauth: { timestamp: 1 } },
    },
  };
  const mcp = {
    list: vi.fn(async () => state),
    listTools: vi.fn(async () => ({ tools: [{ name: "safe-tool", description: "private metadata must not be sent" }] })),
    reload: vi.fn(async () => {}),
    oauth: { login: vi.fn(async () => ({ authorizationUrl: "https://example.com/native-login?state=nonce" })) },
  };
  const runtime = new ManagedRuntime("session", false, nativeMcpSignIn);
  runtime.bind({ rpc: { mcp } });
  return { runtime, mcp, state };
}

describe("native MCP controls", () => {
  it("uses Terminal authentication on the first snapshot and rejects login before invoking OAuth when native sign-in is disabled", async () => {
    const { runtime, mcp, state } = mcpHarness(false);
    state.servers.push({ name: "github-mcp-server", status: "connected", source: "builtin" });
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "needs-auth", authentication: "terminal" });
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "github-mcp-server", status: "connected", authentication: "copilot-account" });
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("Terminal authentication is required"),
    });
    expect(mcp.oauth.login).not.toHaveBeenCalled();
    await runtime.mcpAction("mcp-reload");
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "needs-auth", authentication: "terminal" });
    state.host!.clients.push("oauth");
    delete state.host!.needsAuthServers!.oauth;
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "connected", authentication: "none" });
    expect(await runtime.mcpAction("mcp-tools", "oauth")).toEqual({ tools: ["safe-tool"] });
    expect(mcp.oauth.login).not.toHaveBeenCalled();
  });

  it("reports all host states without exposing headers, config or raw failures", async () => {
    const { runtime } = mcpHarness();
    const snapshot = await runtime.snapshot();
    expect(snapshot.mcp).toEqual(expect.arrayContaining([
      { name: "native", status: "connected", authentication: "none" }, { name: "pending", status: "connecting", authentication: "none" },
      { name: "disabled", status: "disabled", authentication: "none" }, { name: "filtered", status: "policy-filtered", authentication: "none" },
      { name: "broken", status: "failed", authentication: "none" }, { name: "oauth", status: "needs-auth", authentication: "oauth" },
    ]));
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-secret");
  });

  it("verifies live tools and reuses the native OAuth flow without accepting tokens", async () => {
    const { runtime, mcp } = mcpHarness();
    expect(await runtime.mcpAction("mcp-tools", "native")).toEqual({ tools: ["safe-tool"] });
    expect(await runtime.mcpAction("mcp-login", "oauth")).toEqual({ authorizationUrl: "https://example.com/native-login?state=nonce" });
    expect(mcp.oauth.login).toHaveBeenCalledExactlyOnceWith({ serverName: "oauth" });
    expect(await runtime.mcpAction("mcp-reload")).toEqual({ reloaded: true });
    expect(mcp.reload).toHaveBeenCalledOnce();
  });

  it("blocks unregistered, disabled, policy-filtered and ended-session actions", async () => {
    const { runtime, mcp } = mcpHarness();
    for (const name of ["foreign-repo", "disabled", "filtered"]) await expect(runtime.mcpAction("mcp-login", name)).rejects.toThrow();
    expect(mcp.oauth.login).not.toHaveBeenCalled();
    runtime.close();
    await expect(runtime.mcpAction("mcp-reload")).rejects.toThrow("ended");
  });

  it("does not start generic OAuth for connected servers or builtin Copilot-account servers", async () => {
    const { runtime, mcp, state } = mcpHarness();
    state.servers.push({ name: "github-mcp-server", status: "connected", source: "builtin" });
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "github-mcp-server", status: "connected", authentication: "copilot-account" });
    await expect(runtime.mcpAction("mcp-login", "github-mcp-server")).rejects.toThrow("Copilot account");
    await expect(runtime.mcpAction("mcp-login", "native")).rejects.toThrow("already connected");
    await expect(runtime.mcpAction("mcp-login", "broken")).rejects.toThrow("has not reported");
    expect(mcp.oauth.login).not.toHaveBeenCalled();
    expect(await runtime.mcpAction("mcp-tools", "github-mcp-server")).toEqual({ tools: ["safe-tool"] });
  });

  it("preserves explicit pending-auth state even when the host still lists the client", async () => {
    const { runtime, mcp, state } = mcpHarness();
    state.host!.clients.push("oauth");
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "needs-auth", authentication: "oauth" });
    await runtime.mcpAction("mcp-login", "oauth");
    expect(mcp.oauth.login).toHaveBeenCalledOnce();
    state.servers.push({ name: "account-auth", status: "needs-auth", source: "builtin" });
    await expect(runtime.mcpAction("mcp-login", "account-auth")).rejects.toThrow("native Copilot authentication");
    expect(mcp.oauth.login).toHaveBeenCalledOnce();
  });

  it("uses runtime source rather than the server name to distinguish builtin account authentication", async () => {
    const { runtime, mcp, state } = mcpHarness();
    state.servers.push({ name: "github-mcp-server", status: "needs-auth", source: "user" });
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "github-mcp-server", status: "needs-auth", authentication: "oauth" });
    await runtime.mcpAction("mcp-login", "github-mcp-server");
    expect(mcp.oauth.login).toHaveBeenCalledExactlyOnceWith({ serverName: "github-mcp-server" });
  });

  it("explains unsupported OAuth client registration without leaking raw RPC details", async () => {
    const { runtime, mcp } = mcpHarness();
    mcp.oauth.login.mockRejectedValueOnce(Object.assign(new Error("Client registration failed: Authorization server does not support dynamic client registration; private-auth-detail"), { code: -32603 }));
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("does not support automatic OAuth client registration"),
    });

    mcp.oauth.login.mockRejectedValueOnce(new Error("Authorization server does not support dynamic client registration; private-auth-detail"));
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.not.toThrow("private-auth-detail");
  });

  it("explains missing Entra host configuration and does not repeat a known unsupported sign-in", async () => {
    const { runtime, mcp } = mcpHarness();
    mcp.oauth.login.mockRejectedValueOnce(Object.assign(new Error(
      "Request session.mcp.oauth.login failed with message: Microsoft Entra authentication requires the host to configure an Entra client ID; private-auth-detail",
    ), { code: -32603 }));
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("Terminal authentication is required"),
    });
    const snapshot = await runtime.snapshot();
    expect(snapshot.mcp).toContainEqual({ name: "oauth", status: "needs-auth", authentication: "entra-host-required" });
    expect(JSON.stringify(snapshot)).not.toContain("private-auth-detail");
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.toMatchObject({
      message: expect.stringContaining("Terminal credentials may not be reusable"),
    });
    expect(mcp.oauth.login).toHaveBeenCalledOnce();
    await runtime.mcpAction("mcp-reload");
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "needs-auth", authentication: "entra-host-required" });
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.toThrow("Terminal authentication is required");
    expect(mcp.oauth.login).toHaveBeenCalledOnce();
  });

  it("scopes missing Entra host configuration to the exact server and bound session", async () => {
    const { runtime, mcp, state } = mcpHarness();
    mcp.oauth.login.mockRejectedValueOnce(new Error("Microsoft Entra authentication requires the host to configure an Entra client ID"));
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.toThrow("Terminal authentication is required");
    state.host!.needsAuthServers!["other-oauth"] = { timestamp: 2 };
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "other-oauth", status: "needs-auth", authentication: "oauth" });
    await runtime.mcpAction("mcp-login", "other-oauth");
    state.host!.clients.push("oauth");
    delete state.host!.needsAuthServers!.oauth;
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "connected", authentication: "none" });
    expect(await runtime.mcpAction("mcp-tools", "oauth")).toEqual({ tools: ["safe-tool"] });
    state.host!.needsAuthServers!.oauth = { timestamp: 3 };
    runtime.bind({ rpc: { mcp: { ...mcp } } });
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "needs-auth", authentication: "oauth" });
  });

  it.each([
    ["AADSTS700016: application not found; private-auth-detail", "AADSTS700016"],
    ["AADSTS65001: consent required; private-auth-detail", "tenant consent"],
    ["Entra broker error: A Microsoft sign-in is already in progress. private-auth-detail", "already in progress"],
  ])("explains an Entra rejection without raw identity details (%s)", async (nativeMessage, safeMessage) => {
    const { runtime, mcp } = mcpHarness();
    mcp.oauth.login.mockRejectedValueOnce(Object.assign(new Error(nativeMessage), { code: -32603 }));
    let rejected: unknown;
    try { await runtime.mcpAction("mcp-login", "oauth"); }
    catch (error) { rejected = error; }
    expect(rejected).toMatchObject({ status: 409, message: expect.stringContaining(safeMessage) });
    expect(rejected).toMatchObject({ message: expect.not.stringContaining("private-auth-detail") });
    expect((await runtime.snapshot()).mcp).toContainEqual({ name: "oauth", status: "needs-auth", authentication: "oauth" });
  });

  it("surfaces unsupported RPC methods, isolates MCP failures from pending approvals and hides credentials", async () => {
    const { runtime, mcp } = mcpHarness();
    mcp.list.mockRejectedValue(Object.assign(new Error("Authorization: Bearer synthetic-secret"), { code: -32601 }));
    const pending = runtime.onPermissionRequest({ kind: "read", path: "C:\\fixture", intention: "Read" }, { sessionId: "session" });
    const snapshot = await runtime.snapshot();
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.mcpError).toContain("RPC -32601");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-secret");
    runtime.close();
    await pending;
  });

  it("rejects unsafe OAuth redirects and never turns RPC errors into success", async () => {
    const { runtime, mcp } = mcpHarness();
    mcp.oauth.login.mockResolvedValueOnce({ authorizationUrl: "http://untrusted.example/auth" });
    await expect(runtime.mcpAction("mcp-login", "oauth")).rejects.toThrow("unsafe");
    mcp.listTools.mockRejectedValueOnce(new Error("Bearer synthetic-secret"));
    await expect(runtime.mcpAction("mcp-tools", "native")).rejects.toThrow("tools/list failed");
  });
});
