import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachStdioJsonRpc,
  createSupportIqBridgeSession,
  createWamTseTokenProvider,
  extractSseEvents,
  selectTseWamAccount,
} from "../../scripts/supportiq-mcp-bridge.mjs";
import { applyCaseIqSupportIqWamBridge } from "../../scripts/caseiq-native-delegate.mjs";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SupportIQ WAM TSE stdio MCP bridge", () => {
  it("selects only the TSE tenant/domain account and never falls back to corp or personal accounts", () => {
    const accounts = [
      { username: "user@outlook.com", realm: "9188040d-6c67-4c5b-b112-36a304b66dad", accountId: "msa" },
      { username: "user@microsoft.com", realm: "72f988bf-86f1-41af-91ab-2d7cd011db47", accountId: "corp" },
    ];
    expect(selectTseWamAccount(accounts)).toBeNull();

    const withTse = [
      ...accounts,
      {
        username: "user@techsupport.microsoft.com",
        realm: "b4c546a4-7dac-46a6-a7dd-ed822a11efd3",
        accountId: "tse",
      },
    ];
    expect(selectTseWamAccount(withTse)).toMatchObject({ accountId: "tse" });
  });

  it("caches silent WAM TSE tokens and refreshes on expiry or explicit invalidation", async () => {
    let clock = 1_000_000;
    let calls = 0;
    const msalRuntime = {
      AuthParameters: class {
        CreateAuthParameters() {}
        SetRedirectUri() {}
        SetRequestedScopes() {}
      },
      DiscoverAccountsAsync(_clientId: string, _corr: string, cb: (res: unknown) => void) {
        cb({
          CheckError() {},
          accounts: [
            { username: "user@microsoft.com", realm: "72f988bf-86f1-41af-91ab-2d7cd011db47" },
            { username: "user@techsupport.microsoft.com", realm: "b4c546a4-7dac-46a6-a7dd-ed822a11efd3" },
          ],
        });
      },
      AcquireTokenSilentlyAsync(_params: unknown, _corr: string, account: { username: string }, cb: (res: unknown) => void) {
        calls += 1;
        cb({
          CheckError() {},
          accessToken: `tse-token-${calls}-for-${account.username}`,
          expiresOn: Math.floor((clock + 3600_000) / 1000),
        });
      },
    };

    const provider = createWamTseTokenProvider({ msalRuntime, now: () => clock });
    const [first, second] = await Promise.all([provider.getToken(), provider.getToken()]);
    expect(first).toBe("tse-token-1-for-user@techsupport.microsoft.com");
    expect(second).toBe(first);
    expect(calls).toBe(1);

    clock += 3400_000; // Within 5-minute refresh buffer -> acquires fresh token
    expect(await provider.getToken()).toBe("tse-token-2-for-user@techsupport.microsoft.com");
    expect(calls).toBe(2);
  });

  it("never invokes interactive WAM APIs in headless mode when silent TSE acquisition fails", async () => {
    const interactiveSpy = vi.fn();
    const signInSpy = vi.fn();
    const msalRuntime = {
      AuthParameters: class {
        CreateAuthParameters() {}
        SetRedirectUri() {}
        SetRequestedScopes() {}
      },
      DiscoverAccountsAsync(_clientId: string, _corr: string, cb: (res: unknown) => void) {
        cb({
          CheckError() {},
          accounts: [{ username: "user@techsupport.microsoft.com", realm: "b4c546a4-7dac-46a6-a7dd-ed822a11efd3" }],
        });
      },
      AcquireTokenSilentlyAsync(_params: unknown, _corr: string, _account: unknown, cb: (res: unknown) => void) {
        cb({
          CheckError() {
            throw new Error("interaction_required: MFA expired");
          },
        });
      },
      AcquireTokenInteractivelyAsync: interactiveSpy,
      SignInInteractivelyAsync: signInSpy,
    };

    const headlessProvider = createWamTseTokenProvider({ msalRuntime, interactive: false });
    await expect(headlessProvider.getToken()).rejects.toThrow("Resume in Terminal");
    expect(interactiveSpy).not.toHaveBeenCalled();
    expect(signInSpy).not.toHaveBeenCalled();
  });

  it("falls back to interactive WAM renewal or TSE sign-in only when interactive mode is enabled", async () => {
    let interactiveCalls = 0;
    const mfaRuntime = {
      AuthParameters: class {
        CreateAuthParameters() {}
        SetRedirectUri() {}
        SetRequestedScopes() {}
      },
      DiscoverAccountsAsync(_clientId: string, _corr: string, cb: (res: unknown) => void) {
        cb({
          CheckError() {},
          accounts: [{ username: "user@techsupport.microsoft.com", realm: "b4c546a4-7dac-46a6-a7dd-ed822a11efd3" }],
        });
      },
      AcquireTokenSilentlyAsync(_params: unknown, _corr: string, _account: unknown, cb: (res: unknown) => void) {
        cb({
          CheckError() {
            throw new Error("interaction_required");
          },
        });
      },
      AcquireTokenInteractivelyAsync(
        _hwnd: Buffer,
        _params: unknown,
        _corr: string,
        account: { username: string; realm: string },
        cb: (res: unknown) => void,
      ) {
        interactiveCalls += 1;
        cb({
          CheckError() {},
          account,
          accessToken: `interactive-tse-token-${interactiveCalls}`,
          expiresOn: Math.floor(Date.now() / 1000) + 3600,
        });
      },
    };

    const renewalProvider = createWamTseTokenProvider({ msalRuntime: mfaRuntime, interactive: true });
    expect(await renewalProvider.getToken()).toBe("interactive-tse-token-1");
    expect(interactiveCalls).toBe(1);

    // When no TSE account is signed in yet, uses SignInInteractivelyAsync and rejects non-TSE accounts.
    let selectedAccount = { username: "user@microsoft.com", realm: "72f988bf-86f1-41af-91ab-2d7cd011db47" };
    const newAccountRuntime = {
      AuthParameters: class {
        CreateAuthParameters() {}
        SetRedirectUri() {}
        SetRequestedScopes() {}
      },
      DiscoverAccountsAsync(_clientId: string, _corr: string, cb: (res: unknown) => void) {
        cb({ CheckError() {}, accounts: [] });
      },
      SignInInteractivelyAsync(
        _hwnd: Buffer,
        _params: unknown,
        _corr: string,
        _hint: string,
        cb: (res: unknown) => void,
      ) {
        cb({
          CheckError() {},
          account: selectedAccount,
          accessToken: "fresh-sign-in-token",
          expiresOn: Math.floor(Date.now() / 1000) + 3600,
        });
      },
    };

    const signInProvider = createWamTseTokenProvider({ msalRuntime: newAccountRuntime, interactive: true });
    await expect(signInProvider.getToken()).rejects.toThrow("does not belong to the SupportIQ TSE tenant");

    selectedAccount = { username: "user@techsupport.microsoft.com", realm: "b4c546a4-7dac-46a6-a7dd-ed822a11efd3" };
    expect(await signInProvider.getToken()).toBe("fresh-sign-in-token");
  });

  it("retries once on HTTP 401 and transparently re-initializes on HTTP 404 session expiry", async () => {
    let tokenSeq = 0;
    const tokenProvider = {
      invalidate: vi.fn(),
      getToken: vi.fn(async () => `token-${++tokenSeq}`),
    };
    const emitted: unknown[] = [];
    const requests: { auth: string | null; sid: string | null; method: string }[] = [];
    let toolCallAttempt = 0;

    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      requests.push({
        auth: headers.get("authorization"),
        sid: headers.get("mcp-session-id"),
        method: body.method,
      });

      if (body.method === "initialize") {
        return new Response(
          `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { protocolVersion: "2025-03-26" } })}\r\n\r\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream", "mcp-session-id": `sid-${requests.length}` },
          },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      toolCallAttempt += 1;
      if (toolCallAttempt === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (toolCallAttempt === 2) {
        return new Response("Session expired", { status: 404 });
      }
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const session = createSupportIqBridgeSession({
      endpoint: "https://api.support.microsoft.com/v2/supportiq/mcp",
      tokenProvider,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      writeMessage: (msg: unknown) => emitted.push(msg),
    });

    await session.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await session.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    await session.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "scope_resolve" } });

    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
    expect(emitted).toEqual([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", id: 2, result: { ok: true } },
    ]);
    expect(requests.at(-1)?.sid).toBe("sid-5");
  });

  it("parses incremental SSE chunks and preserves stdio framing modes", () => {
    const partial = extractSseEvents('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\nevent: message\ndata: {"half":');
    expect(partial.messages).toEqual([{ jsonrpc: "2.0", id: 1 }]);
    expect(partial.rest).toContain('{"half":');

    const input = new PassThrough();
    const output = new PassThrough();
    const received: unknown[] = [];
    const { writeMessage } = attachStdioJsonRpc(input, output, (msg: unknown) => received.push(msg));

    const payload = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" });
    input.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    expect(received).toEqual([{ jsonrpc: "2.0", id: 9, method: "ping" }]);

    writeMessage({ jsonrpc: "2.0", id: 9, result: {} });
    const written = output.read()?.toString("utf8") ?? "";
    expect(written).toMatch(/^Content-Length: \d+\r\n\r\n\{/);
  });

  it("rewrites CaseIQ additional-mcp-config SupportIQ HTTP entries to the WAM TSE stdio bridge when a TSE WAM account is available", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "workboard-caseiq-wam-"));
    cleanupDirs.push(tempDir);
    const channelConfigPath = path.join(tempDir, "mcp-config-channel.json");
    await writeFile(
      channelConfigPath,
      JSON.stringify({
        mcpServers: {
          SupportIQ: {
            type: "http",
            url: "https://api.support.microsoft.com/v2/supportiq/mcp",
            tools: ["case_get", "get_case_notes", "scope_resolve"],
          },
        },
      }),
      "utf8",
    );

    const tseRuntime = {
      DiscoverAccountsAsync(_clientId: string, _corr: string, cb: (res: unknown) => void) {
        cb({
          CheckError() {},
          accounts: [
            { username: "user@microsoft.com", realm: "72f988bf-86f1-41af-91ab-2d7cd011db47" },
            { username: "user@techsupport.microsoft.com", realm: "b4c546a4-7dac-46a6-a7dd-ed822a11efd3" },
          ],
        });
      },
    };
    const corpOnlyRuntime = {
      DiscoverAccountsAsync(_clientId: string, _corr: string, cb: (res: unknown) => void) {
        cb({
          CheckError() {},
          accounts: [{ username: "user@microsoft.com", realm: "72f988bf-86f1-41af-91ab-2d7cd011db47" }],
        });
      },
    };

    const baseInvocation = {
      nativeArguments: [
        "-p",
        "check case",
        "--additional-mcp-config",
        `@${channelConfigPath}`,
      ],
    };

    // Skips when authenticationOnly is true
    const authOnly = await applyCaseIqSupportIqWamBridge(
      { authenticationOnly: true, requestDirectory: tempDir },
      baseInvocation,
      { platform: "win32", msalRuntime: tseRuntime, forceEnable: true },
    );
    expect(authOnly.nativeArguments).toEqual(baseInvocation.nativeArguments);

    // Skips when no TSE account is signed into Windows WAM
    const noTse = await applyCaseIqSupportIqWamBridge(
      { authenticationOnly: false, requestDirectory: tempDir },
      baseInvocation,
      { platform: "win32", msalRuntime: corpOnlyRuntime, forceEnable: true },
    );
    expect(noTse.nativeArguments).toEqual(baseInvocation.nativeArguments);

    // Rewrites to local WAM bridge when TSE account is present
    const rewritten = await applyCaseIqSupportIqWamBridge(
      { authenticationOnly: false, requestDirectory: tempDir },
      baseInvocation,
      {
        platform: "win32",
        msalRuntime: tseRuntime,
        bridgeScriptPath: "C:\\bridge\\supportiq-mcp-bridge.mjs",
        nodeExecutable: "C:\\node\\node.exe",
        forceEnable: true,
      },
    );
    expect(rewritten.nativeArguments[3]).not.toBe(`@${channelConfigPath}`);
    const stagedPath = rewritten.nativeArguments[3].slice(1);
    const stagedJson = JSON.parse(await readFile(stagedPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(stagedJson.mcpServers.SupportIQ).toEqual({
      type: "local",
      command: "C:\\node\\node.exe",
      args: ["C:\\bridge\\supportiq-mcp-bridge.mjs"],
      tools: ["case_get", "get_case_notes", "scope_resolve"],
      timeout: 120_000,
    });
  });
});
