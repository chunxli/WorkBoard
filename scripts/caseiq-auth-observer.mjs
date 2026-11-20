import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function inspectSupportIqConnection(session) {
  const state = await session.rpc.mcp.list();
  const server = state.servers.find((entry) => entry.name === "SupportIQ");
  if (!server) return { status: "not-configured", toolCount: null };
  if (server.status !== "connected") {
    return { status: ["needs-auth", "failed", "pending", "disabled"].includes(server.status) ? server.status : "unknown", toolCount: null };
  }
  const tools = await session.rpc.mcp.listTools({ serverName: "SupportIQ" });
  const refreshed = await session.rpc.mcp.list();
  if (!refreshed.servers.some((entry) => entry.name === "SupportIQ" && entry.status === "connected")) {
    return { status: "unknown", toolCount: null };
  }
  return { status: tools.tools.length ? "connected" : "unknown", toolCount: tools.tools.length };
}

function oauthFailureKind(error) {
  const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
  if (/not enough memory resources|keyring|credential.*(?:store|cache)|cache.*(?:decrypt|corrupt|unavailable)|cached account/i.test(message)) {
    return "native-oauth-cache-unavailable";
  }
  if (/refresh|invalid_grant|expired|revoked|AADSTS/i.test(message)) return "native-oauth-refresh-failed";
  if (/client.?id|client configuration|redirect.uri|invalid.client/i.test(message)) return "native-oauth-client-configuration";
  if (/fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|timeout|certificate|TLS/i.test(message)) return "native-oauth-network-error";
  if (/not supported|unsupported|not implemented|method.*not.*found/i.test(message)) return "native-oauth-probe-unsupported";
  return "native-oauth-probe-failed";
}

export async function inspectSupportIqOAuth(session) {
  const unknown = (errorKind) => ({ status: "unknown", reason: null, httpStatus: null, errorKind });
  if (typeof session.rpc.mcp.oauth?.probe !== "function") return unknown("native-oauth-probe-unsupported");
  try {
    const result = await session.rpc.mcp.oauth.probe({ serverName: "SupportIQ" });
    if (!["authenticated", "no-auth-required", "needs-auth", "failed"].includes(result.status)) {
      return unknown("native-oauth-probe-invalid");
    }
    return {
      status: result.status,
      reason: ["initial", "refresh", "upscope"].includes(result.reason) ? result.reason : null,
      httpStatus: Number.isInteger(result.httpResponse?.statusCode) ? result.httpResponse.statusCode : null,
      errorKind: result.status === "failed" ? oauthFailureKind(result.error) : null,
    };
  } catch (error) {
    return unknown(error?.code === -32601 ? "native-oauth-probe-unsupported" : oauthFailureKind(error));
  }
}

async function observe() {
  const context = JSON.parse(await readFile(new URL("./context.json", import.meta.url), "utf8"));
  const { joinSession } = await import("@github/copilot-sdk/extension");
  const session = await joinSession();
  if (session.sessionId !== context.sessionId) throw new Error("Authentication observer joined a different session.");
  const file = path.join(context.requestDirectory, "mcp-status.json");
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      let result;
      try { result = { ...await inspectSupportIqConnection(session), errorKind: null }; }
      catch { result = { status: "unknown", toolCount: null, errorKind: "native-mcp-verification-failed" }; }
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({
        ...context.correlation, sessionId: context.sessionId, preparedHash: context.preparedHash,
        checkedAt: new Date().toISOString(), ...result,
      }), { mode: 0o600 });
      await rename(temporary, file);
      const oauthFile = path.join(context.requestDirectory, "mcp-oauth-probe.json");
      const oauthTemporary = `${oauthFile}.${process.pid}.tmp`;
      await writeFile(oauthTemporary, JSON.stringify({
        ...context.correlation, sessionId: context.sessionId, preparedHash: context.preparedHash,
        checkedAt: new Date().toISOString(), ...await inspectSupportIqOAuth(session),
      }), { mode: 0o600 });
      await rename(oauthTemporary, oauthFile);
    } finally { checking = false; }
  };
  await check();
  const timer = setInterval(() => { void check().catch(() => {
    console.error("[WorkBoard auth observer] Status persistence failed.");
  }); }, 2000);
  timer.unref();
}

if (path.basename(fileURLToPath(import.meta.url)) === "extension.mjs") {
  observe().catch(() => {
    console.error("[WorkBoard auth observer] Native observation is unavailable.");
    process.exitCode = 1;
  });
}
