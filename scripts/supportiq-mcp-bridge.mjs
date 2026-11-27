import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SUPPORTIQ_URL = "https://api.support.microsoft.com/v2/supportiq/mcp";
export const DEFAULT_TSE_TENANT_ID = "b4c546a4-7dac-46a6-a7dd-ed822a11efd3";
export const DEFAULT_SUPPORTIQ_SCOPE = "6c25ecb7-9e1e-489a-9747-39f3573ee4e8/.default";
export const DEFAULT_WAM_CLIENT_ID = "aebc6443-996d-45c2-90f0-388ff96faa56";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function compareSemverDesc(left, right) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const l = Number.isFinite(leftParts[index]) ? leftParts[index] : -1;
    const r = Number.isFinite(rightParts[index]) ? rightParts[index] : -1;
    if (l !== r) return r - l;
  }
  return right.localeCompare(left);
}

export function findMsalNodeRuntimePath({
  env = process.env,
  fsImpl = fs,
  arch = process.arch,
} = {}) {
  const explicit = env.WORKBOARD_MSAL_RUNTIME_PATH?.trim();
  if (explicit && fsImpl.existsSync(explicit)) {
    return path.resolve(explicit);
  }
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;

  const preferredArch = `win32-${arch}`;
  const pkgRoot = path.join(localAppData, "copilot", "pkg");
  if (fsImpl.existsSync(pkgRoot)) {
    const archDirs = fsImpl
      .readdirSync(pkgRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("win32-"))
      .map((entry) => entry.name)
      .sort((a, b) => (a === preferredArch ? -1 : b === preferredArch ? 1 : a.localeCompare(b)));

    for (const archName of archDirs) {
      const archPath = path.join(pkgRoot, archName);
      const versions = fsImpl
        .readdirSync(archPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareSemverDesc);

      for (const version of versions) {
        const candidate = path.join(
          archPath,
          version,
          "prebuilds",
          archName,
          "msal-node-runtime.node",
        );
        if (fsImpl.existsSync(candidate)) return candidate;
      }
    }
  }

  const vscodeRoot = path.join(localAppData, "Programs", "Microsoft VS Code");
  if (fsImpl.existsSync(vscodeRoot)) {
    for (const entry of fsImpl.readdirSync(vscodeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(
        vscodeRoot,
        entry.name,
        "resources",
        "app",
        "node_modules.asar.unpacked",
        `@microsoft`,
        `copilot-sdk-${preferredArch}`,
        "prebuilds",
        preferredArch,
        "msal-node-runtime.node",
      );
      if (fsImpl.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function selectTseWamAccount(
  accounts,
  {
    tenantId = DEFAULT_TSE_TENANT_ID,
    preferredUsername = process.env.SUPPORTIQ_TSE_USERNAME?.trim() || "",
  } = {},
) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const normalizedTenant = tenantId.trim().toLowerCase();
  const normalizedPreferred = preferredUsername.trim().toLowerCase();

  const tenantMatches = accounts.filter(
    (account) =>
      typeof account?.realm === "string" &&
      account.realm.trim().toLowerCase() === normalizedTenant,
  );
  if (normalizedPreferred) {
    const exact = tenantMatches.find(
      (account) =>
        typeof account?.username === "string" &&
        account.username.trim().toLowerCase() === normalizedPreferred,
    );
    if (exact) return exact;
  }
  if (tenantMatches.length > 0) return tenantMatches[0];

  const domainMatches = accounts.filter(
    (account) =>
      typeof account?.username === "string" &&
      /@techsupport\.microsoft\.com$/i.test(account.username.trim()),
  );
  if (normalizedPreferred) {
    const exact = domainMatches.find(
      (account) => account.username.trim().toLowerCase() === normalizedPreferred,
    );
    if (exact) return exact;
  }
  return domainMatches[0] ?? null;
}

function isVerifiedTseResult(tokenResult, tenantId) {
  const normalizedTenant = tenantId.trim().toLowerCase();
  if (tokenResult?.account) {
    return selectTseWamAccount([tokenResult.account], { tenantId }) !== null;
  }
  const rawToken = typeof tokenResult?.accessToken === "string" ? tokenResult.accessToken : "";
  const parts = rawToken.split(".");
  if (parts.length >= 2) {
    try {
      const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      if (typeof claims?.tid === "string") {
        return claims.tid.trim().toLowerCase() === normalizedTenant;
      }
    } catch {
      // Non-JWT opaque tokens are accepted when issued against the TSE tenant authority.
    }
  }
  return true;
}

/**
 * @param {{
 *   msalRuntime?: any;
 *   clientId?: string;
 *   tenantId?: string;
 *   scope?: string;
 *   preferredUsername?: string;
 *   interactive?: boolean;
 *   now?: () => number;
 * }} [options]
 */
export function createWamTseTokenProvider({
  msalRuntime = null,
  clientId = process.env.SUPPORTIQ_CLIENT_ID?.trim() || DEFAULT_WAM_CLIENT_ID,
  tenantId = process.env.SUPPORTIQ_TENANT_ID?.trim() || DEFAULT_TSE_TENANT_ID,
  scope = process.env.SUPPORTIQ_SCOPE?.trim() || DEFAULT_SUPPORTIQ_SCOPE,
  preferredUsername = process.env.SUPPORTIQ_TSE_USERNAME?.trim() || "",
  interactive = process.env.SUPPORTIQ_INTERACTIVE_AUTH === "1",
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let pending = null;

  function buildAuthParameters() {
    const authority = `https://login.microsoftonline.com/${tenantId}`;
    const redirectUri = `ms-appx-web://Microsoft.AAD.BrokerPlugin/${clientId}`;
    const params = new msalRuntime.AuthParameters();
    params.CreateAuthParameters(clientId, authority);
    params.SetRedirectUri(redirectUri);
    params.SetRequestedScopes(scope);
    return params;
  }

  function cacheAndExtractToken(tokenResult) {
    tokenResult.CheckError();
    const accessToken = tokenResult.accessToken;
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Error("Windows WAM returned an empty SupportIQ access token.");
    }
    if (!isVerifiedTseResult(tokenResult, tenantId)) {
      throw new Error(
        `The selected account does not belong to the SupportIQ TSE tenant (${tenantId}). Sign in with your @techsupport.microsoft.com TSE account.`,
      );
    }
    const expiresOnSeconds = Number(tokenResult.expiresOn);
    const expiresAtMs =
      Number.isFinite(expiresOnSeconds) && expiresOnSeconds > 0
        ? expiresOnSeconds * 1000
        : now() + 45 * 60 * 1000;
    cached = { accessToken, expiresAtMs };
    return accessToken;
  }

  function acquireInteractiveToken(params, tseAccount) {
    const windowHandle = Buffer.from([0]);
    const signInNewAccount = () =>
      new Promise((resolve, reject) => {
        if (typeof msalRuntime.SignInInteractivelyAsync !== "function") {
          reject(new Error("Windows WAM interactive sign-in API is unavailable."));
          return;
        }
        try {
          msalRuntime.SignInInteractivelyAsync(
            windowHandle,
            params,
            randomUUID(),
            preferredUsername || "",
            (tokenResult) => {
              try {
                resolve(cacheAndExtractToken(tokenResult));
              } catch (error) {
                reject(
                  new Error(
                    `Interactive TSE sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            },
          );
        } catch (error) {
          reject(error);
        }
      });

    if (!tseAccount || typeof msalRuntime.AcquireTokenInteractivelyAsync !== "function") {
      return signInNewAccount();
    }

    return new Promise((resolve, reject) => {
      try {
        msalRuntime.AcquireTokenInteractivelyAsync(
          windowHandle,
          params,
          randomUUID(),
          tseAccount,
          (tokenResult) => {
            try {
              resolve(cacheAndExtractToken(tokenResult));
            } catch (error) {
              reject(
                new Error(
                  `Interactive TSE token renewal failed for ${tseAccount.username ?? "TSE account"}: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            }
          },
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  function acquireFreshToken() {
    if (!msalRuntime) {
      return Promise.reject(
        new Error("Windows WAM runtime (msal-node-runtime.node) is not available on this machine."),
      );
    }
    return new Promise((resolve, reject) => {
      try {
        msalRuntime.DiscoverAccountsAsync(clientId, randomUUID(), (discoverResult) => {
          try {
            discoverResult.CheckError();
          } catch (error) {
            reject(
              new Error(
                `WAM account discovery failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
            return;
          }
          const params = buildAuthParameters();
          const tseAccount = selectTseWamAccount(discoverResult.accounts ?? [], {
            tenantId,
            preferredUsername,
          });
          if (!tseAccount) {
            if (interactive) {
              acquireInteractiveToken(params, null).then(resolve, reject);
              return;
            }
            reject(
              new Error(
                `No TSE account (@techsupport.microsoft.com / tenant ${tenantId}) is signed into Windows Account Manager. Click Resume in Terminal ([>_]) or Sign in to SupportIQ to complete TSE sign-in.`,
              ),
            );
            return;
          }
          msalRuntime.AcquireTokenSilentlyAsync(params, randomUUID(), tseAccount, (tokenResult) => {
            try {
              resolve(cacheAndExtractToken(tokenResult));
            } catch (error) {
              if (interactive) {
                acquireInteractiveToken(params, tseAccount).then(resolve, reject);
                return;
              }
              reject(
                new Error(
                  `Silent TSE token acquisition failed for ${tseAccount.username ?? "TSE account"}: ${error instanceof Error ? error.message : String(error)}. Click Resume in Terminal ([>_]) or Sign in to SupportIQ to refresh your TSE session.`,
                ),
              );
            }
          });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  return {
    invalidate() {
      cached = null;
    },
    async getToken({ forceRefresh = false } = {}) {
      if (!forceRefresh && cached && now() + TOKEN_REFRESH_BUFFER_MS < cached.expiresAtMs) {
        return cached.accessToken;
      }
      if (forceRefresh) cached = null;
      if (!pending) {
        pending = acquireFreshToken().finally(() => {
          pending = null;
        });
      }
      return pending;
    },
  };
}

export function extractSseEvents(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const messages = [];
  for (const block of blocks) {
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") continue;
    messages.push(JSON.parse(payload));
  }
  return { messages, rest };
}

export function createSupportIqBridgeSession({
  endpoint = process.env.SUPPORTIQ_MCP_URL?.trim() || DEFAULT_SUPPORTIQ_URL,
  tokenProvider,
  fetchImpl = fetch,
  writeMessage,
  onDebug = () => {},
}) {
  let mcpSessionId = null;
  let savedInitializeMessage = null;
  let reinitializing = null;

  async function postJsonRpc(message, { forceTokenRefresh = false } = {}) {
    const token = await tokenProvider.getToken({ forceRefresh: forceTokenRefresh });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (mcpSessionId && message?.method !== "initialize") {
      headers["Mcp-Session-Id"] = mcpSessionId;
    }
    return fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
  }

  async function consumeSseBody(response, emit) {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      const { messages } = extractSseEvents(`${text}\n\n`);
      for (const item of messages) emit(item);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let pendingText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pendingText += decoder.decode(value, { stream: true });
      const parsed = extractSseEvents(pendingText);
      pendingText = parsed.rest;
      for (const item of parsed.messages) emit(item);
    }
    pendingText += decoder.decode();
    if (pendingText.trim()) {
      const parsed = extractSseEvents(`${pendingText}\n\n`);
      for (const item of parsed.messages) emit(item);
    }
  }

  async function refreshRemoteSession() {
    if (!savedInitializeMessage) return false;
    if (!reinitializing) {
      reinitializing = (async () => {
        mcpSessionId = null;
        const initResp = await postJsonRpc(savedInitializeMessage);
        if (!initResp.ok) return false;
        const nextSessionId = initResp.headers.get("mcp-session-id");
        if (nextSessionId) mcpSessionId = nextSessionId;
        await initResp.text().catch(() => {});
        const initializedResp = await postJsonRpc({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        await initializedResp.text().catch(() => {});
        return true;
      })().finally(() => {
        reinitializing = null;
      });
    }
    return reinitializing;
  }

  async function handleMessage(message) {
    const isRequest =
      message !== null &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      "id" in message &&
      message.id !== undefined;

    if (message?.method === "initialize") {
      savedInitializeMessage = message;
      mcpSessionId = null;
    }

    try {
      let response = await postJsonRpc(message);
      if (response.status === 401) {
        onDebug("Received 401 from SupportIQ; refreshing TSE WAM token and retrying once.");
        tokenProvider.invalidate();
        response = await postJsonRpc(message, { forceTokenRefresh: true });
      }
      if (response.status === 404 && mcpSessionId && message?.method !== "initialize") {
        onDebug("Remote SupportIQ MCP session expired (404); re-initializing session.");
        if (await refreshRemoteSession()) {
          response = await postJsonRpc(message);
        }
      }

      const returnedSessionId = response.headers.get("mcp-session-id");
      if (returnedSessionId) mcpSessionId = returnedSessionId;

      if (response.status === 202 || response.status === 204) {
        await response.text().catch(() => {});
        return;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `SupportIQ HTTP ${response.status}${errorBody ? `: ${errorBody.slice(0, 300)}` : ""}`,
        );
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/event-stream")) {
        await consumeSseBody(response, (item) => writeMessage(item));
        return;
      }

      const bodyText = (await response.text()).trim();
      if (!bodyText) return;
      const parsed = JSON.parse(bodyText);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) writeMessage(entry);
      } else {
        writeMessage(parsed);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onDebug(`SupportIQ bridge error: ${detail}`);
      if (isRequest) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: detail,
          },
        });
      }
    }
  }

  async function close() {
    if (!mcpSessionId) return;
    const sessionToClose = mcpSessionId;
    mcpSessionId = null;
    try {
      const token = await tokenProvider.getToken();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        await fetchImpl(endpoint, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Mcp-Session-Id": sessionToClose,
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Best-effort remote session cleanup on exit.
    }
  }

  return { handleMessage, close };
}

export function attachStdioJsonRpc(input, output, onMessage, onClose = () => {}) {
  let buffer = Buffer.alloc(0);
  let framingMode = null;

  function writeMessage(payload) {
    const serialized = JSON.stringify(payload);
    if (framingMode === "content-length") {
      const byteLength = Buffer.byteLength(serialized, "utf8");
      output.write(`Content-Length: ${byteLength}\r\n\r\n${serialized}`);
    } else {
      output.write(`${serialized}\n`);
    }
  }

  function drainBuffer() {
    while (buffer.length > 0) {
      if (framingMode === null) {
        const preview = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8").trimStart();
        if (!preview) return;
        framingMode = /^content-length:/i.test(preview) ? "content-length" : "newline";
      }

      if (framingMode === "content-length") {
        const headerEndCrLf = buffer.indexOf("\r\n\r\n");
        const headerEndLf = buffer.indexOf("\n\n");
        let headerEnd = -1;
        let separatorLength = 0;
        if (headerEndCrLf >= 0 && (headerEndLf < 0 || headerEndCrLf <= headerEndLf)) {
          headerEnd = headerEndCrLf;
          separatorLength = 4;
        } else if (headerEndLf >= 0) {
          headerEnd = headerEndLf;
          separatorLength = 2;
        }
        if (headerEnd < 0) return;

        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const match = headerText.match(/content-length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + separatorLength);
          continue;
        }
        const contentLength = Number.parseInt(match[1], 10);
        const messageEnd = headerEnd + separatorLength + contentLength;
        if (buffer.length < messageEnd) return;
        const jsonText = buffer.subarray(headerEnd + separatorLength, messageEnd).toString("utf8");
        buffer = buffer.subarray(messageEnd);
        if (jsonText.trim()) onMessage(JSON.parse(jsonText));
      } else {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex < 0) return;
        const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
        buffer = buffer.subarray(newlineIndex + 1);
        if (line) onMessage(JSON.parse(line));
      }
    }
  }

  input.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    try {
      drainBuffer();
    } catch (error) {
      if (process.env.SUPPORTIQ_BRIDGE_DEBUG === "1") {
        process.stderr.write(
          `[supportiq-mcp-bridge] frame parse error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  });
  input.on("end", onClose);
  input.on("close", onClose);

  return { writeMessage };
}

async function runCliBridge() {
  const require = createRequire(import.meta.url);
  const runtimePath = findMsalNodeRuntimePath();
  const msalRuntime = runtimePath ? require(runtimePath) : null;
  if (process.argv.includes("--login")) {
    const loginProvider = createWamTseTokenProvider({ msalRuntime, interactive: true });
    await loginProvider.getToken({ forceRefresh: true });
    process.stdout.write("SupportIQ TSE authentication verified in Windows Account Manager.\n");
    return;
  }
  const debug =
    process.env.SUPPORTIQ_BRIDGE_DEBUG === "1"
      ? (line) => process.stderr.write(`[supportiq-mcp-bridge] ${line}\n`)
      : () => {};

  const tokenProvider = createWamTseTokenProvider({ msalRuntime });
  let bridgeSession;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await bridgeSession?.close();
    process.exit(0);
  };

  let initChain = Promise.resolve();
  const { writeMessage } = attachStdioJsonRpc(
    process.stdin,
    process.stdout,
    (message) => {
      if (message?.method === "initialize" || message?.method === "notifications/initialized") {
        initChain = initChain.then(() => bridgeSession.handleMessage(message));
      } else {
        void initChain.then(() => bridgeSession.handleMessage(message));
      }
    },
    () => {
      void shutdown();
    },
  );

  bridgeSession = createSupportIqBridgeSession({
    tokenProvider,
    writeMessage,
    onDebug: debug,
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runCliBridge().catch((error) => {
    process.stderr.write(
      `[supportiq-mcp-bridge] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
