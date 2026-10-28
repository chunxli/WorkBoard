import { randomUUID } from "node:crypto";
import {
  approveAll,
  type CopilotSession,
  type ElicitationFieldValue,
  type ElicitationSchema,
  type PermissionHandler,
  type SessionConfig,
} from "@github/copilot-sdk";
import {
  RuntimeControlError,
  safeRuntimeUrl,
  type ManagedRuntimeState,
  type RuntimeInteraction,
  type RuntimeReply,
} from "@/lib/managed-runtime-types";

type Pending = { request: RuntimeInteraction; reply: (value: RuntimeReply) => void; cancel: () => void };
type McpRpc = CopilotSession["rpc"]["mcp"];
type RuntimeSession = { rpc: { mcp: Pick<McpRpc, "list" | "listTools" | "reload"> & { oauth: Pick<McpRpc["oauth"], "login"> } } };

function displayText(text: string): string {
  let result = text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:password|token|secret|authorization|api[-_]key)[\w-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]");
  for (const [name, value] of Object.entries(process.env)) {
    if (/token|secret|password|credential/i.test(name) && value && value.length >= 6) result = result.split(value).join("[redacted]");
  }
  return result;
}

function requiresEntraHost(error: unknown): boolean {
  return error instanceof Error && /Microsoft Entra authentication requires the host to configure an Entra client ID/i.test(error.message);
}

function terminalMcpAuthError(): RuntimeControlError {
  return new RuntimeControlError(409, "Terminal authentication is required for this MCP service in the current setup. In a local Terminal, open this Work's directory, run copilot and use /mcp to select this server and sign in with your company account. Confirm its connection in Terminal, then return here and select Reload native MCP. If connected, use Verify tools. Terminal credentials may not be reusable here; if it still needs authentication, use this MCP in Terminal. No App registration, client secret or token input is needed for this fallback. Work Board has not confirmed MCP access; Allow All does not change authentication.");
}

function rpcError(operation: string, error: unknown): RuntimeControlError {
  if (operation === "sign-in" && requiresEntraHost(error)) return terminalMcpAuthError();
  if (operation === "sign-in" && error instanceof Error && /does not support dynamic client registration/i.test(error.message)) {
    return new RuntimeControlError(409, "This MCP service does not support automatic OAuth client registration. Use the service's supported authentication setup in local Copilot / Terminal. Work Board has not completed sign-in.");
  }
  if (operation === "sign-in" && error instanceof Error) {
    const entraCode = error.message.match(/\bAADSTS\d+\b/)?.[0];
    if (entraCode) {
      return new RuntimeControlError(409, `Microsoft Entra sign-in failed (${entraCode}). Verify Work Board's public-client application registration and the required tenant consent. Work Board has not completed sign-in.`);
    }
    if (/a microsoft sign-in is already in progress/i.test(error.message)) {
      return new RuntimeControlError(409, "A Microsoft sign-in is already in progress. Complete or cancel the existing sign-in window before retrying. Work Board has not completed this sign-in.");
    }
  }
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "number"
    ? ` (RPC ${error.code})` : "";
  return new RuntimeControlError(502, `Copilot MCP ${operation} failed${code}. Use Open Terminal to inspect local runtime diagnostics.`);
}

function validateForm(schema: ElicitationSchema, content: Record<string, ElicitationFieldValue>) {
  for (const key of Object.keys(content)) {
    if (!Object.hasOwn(schema.properties, key)) throw new RuntimeControlError(400, `Unknown form field: ${key}`);
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    const value = Object.hasOwn(content, key) ? content[key] : undefined;
    if (value === undefined) {
      if (schema.required?.includes(key)) throw new RuntimeControlError(400, `Required form field: ${key}`);
      continue;
    }
    let valid = false;
    if (field.type === "boolean") valid = typeof value === "boolean";
    else if (field.type === "number" || field.type === "integer") {
      valid = typeof value === "number" && Number.isFinite(value) &&
        (field.type !== "integer" || Number.isInteger(value)) &&
        (field.minimum === undefined || value >= field.minimum) &&
        (field.maximum === undefined || value <= field.maximum);
    } else if (field.type === "array") {
      const choices = "enum" in field.items ? field.items.enum : field.items.anyOf.map((item) => item.const);
      valid = Array.isArray(value) && value.every((item) => choices.includes(item)) &&
        new Set(value).size === value.length &&
        (field.minItems === undefined || value.length >= field.minItems) &&
        (field.maxItems === undefined || value.length <= field.maxItems);
    } else if (field.type === "string" && typeof value === "string") {
      if ("enum" in field) valid = field.enum.includes(value);
      else if ("oneOf" in field) valid = field.oneOf.some((item) => item.const === value);
      else {
        valid = (field.minLength === undefined || [...value].length >= field.minLength) &&
          (field.maxLength === undefined || [...value].length <= field.maxLength);
        if (valid && field.format === "email") valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        if (valid && field.format === "uri") valid = URL.canParse(value);
        if (valid && field.format === "date") {
          valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) &&
            new Date(value).toISOString().slice(0, 10) === value;
        }
        if (valid && field.format === "date-time") valid = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value));
      }
    }
    if (!valid) throw new RuntimeControlError(400, `Invalid value for form field: ${field.title ?? key}`);
  }
}

export class ManagedRuntime {
  private session: RuntimeSession | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private entraHostRequired = new Set<string>();

  constructor(
    readonly sessionId: string,
    private readonly automaticApproval: boolean,
    private readonly nativeMcpSignIn = false,
  ) {}

  bind(session: RuntimeSession) {
    if (this.session !== session) this.entraHostRequired.clear();
    this.session = session;
  }

  private enqueue(request: RuntimeInteraction, reply: Pending["reply"], cancel: () => void) {
    if (this.closed) { cancel(); return; }
    this.pending.set(request.id, { request, reply, cancel });
  }

  readonly onPermissionRequest: PermissionHandler = (request, invocation) => {
    if (this.automaticApproval && !request.managedApprovalRequired && !invocation.managedSettingsEnabled) {
      return approveAll(request, invocation);
    }
    return new Promise((resolve) => {
      const detail = request.kind === "read" ? request.path
        : request.kind === "write" ? request.fileName
        : request.kind === "mcp" ? `${request.serverName} / ${request.toolName}`
          : "fullCommandText" in request && typeof request.fullCommandText === "string" ? request.fullCommandText
          : request.kind === "url" ? URL.canParse(request.url) ? `${new URL(request.url).origin}${new URL(request.url).pathname}` : "[invalid URL]"
          : "intention" in request && typeof request.intention === "string" ? request.intention : request.kind;
      this.enqueue({
        id: randomUUID(), kind: "permission", title: `Allow ${request.kind}?`,
        detail: displayText(detail ?? request.kind), managed: Boolean(request.managedApprovalRequired || invocation.managedSettingsEnabled),
      }, (value) => {
        if (value.kind !== "permission") throw new RuntimeControlError(400, "A permission decision is required.");
        resolve({ kind: value.approved ? "approve-once" : "denied-interactively-by-user" });
      }, () => resolve({ kind: "denied-no-approval-rule-and-could-not-request-from-user" }));
    });
  };

  readonly onUserInputRequest: NonNullable<SessionConfig["onUserInputRequest"]> = (request) =>
    new Promise((resolve, reject) => {
      const choices = request.choices ?? [];
      this.enqueue({
        id: randomUUID(), kind: "question", question: request.question,
        choices, allowFreeform: request.allowFreeform !== false,
      }, (value) => {
        if (value.kind !== "question") throw new RuntimeControlError(400, "An answer is required.");
        if (request.allowFreeform === false && !choices.includes(value.answer)) {
          throw new RuntimeControlError(400, "Choose one of the offered answers.");
        }
        resolve({ answer: value.answer, wasFreeform: !choices.includes(value.answer) });
      }, () => reject(new RuntimeControlError(409, "The session ended before the question was answered.")));
    });

  readonly onElicitationRequest: NonNullable<SessionConfig["onElicitationRequest"]> = (context) =>
    new Promise((resolve, reject) => {
      let request: RuntimeInteraction;
      if (context.mode === "url") {
        if (!context.url) { reject(new RuntimeControlError(502, "Copilot URL elicitation is missing its URL.")); return; }
        try { request = { id: randomUUID(), kind: "url", message: context.message, url: safeRuntimeUrl(context.url) }; }
        catch (error) { reject(error); return; }
      } else {
        if (!context.requestedSchema) { reject(new RuntimeControlError(502, "Copilot form elicitation is missing its schema.")); return; }
        request = { id: randomUUID(), kind: "form", message: context.message, schema: context.requestedSchema };
      }
      this.enqueue(request, (value) => {
        if (value.kind !== "elicitation") throw new RuntimeControlError(400, "An elicitation response is required.");
        if (request.kind === "form" && value.action === "accept") validateForm(request.schema, value.content ?? {});
        if (request.kind === "url" && value.content !== undefined) throw new RuntimeControlError(400, "URL approval does not accept form data.");
        resolve({ action: value.action, ...(request.kind === "form" && value.action === "accept" ? { content: value.content ?? {} } : {}) });
      }, () => resolve({ action: "cancel" }));
    });

  reply(value: RuntimeReply) {
    const entry = this.pending.get(value.requestId);
    if (!entry || this.closed) throw new RuntimeControlError(409, "This request expired or was already answered. Refresh the runtime panel.");
    entry.reply(value);
    this.pending.delete(value.requestId);
  }

  cancelPending() {
    for (const entry of this.pending.values()) entry.cancel();
    this.pending.clear();
  }

  unbind() { this.session = null; this.cancelPending(); }
  close() { this.closed = true; this.unbind(); }

  private activeSession() {
    if (!this.session || this.closed) throw new RuntimeControlError(409, "The live Copilot session is not ready or has ended.");
    return this.session;
  }

  private async mcpState() {
    try { return await this.activeSession().rpc.mcp.list(); }
    catch (error) {
      if (error instanceof RuntimeControlError) throw error;
      throw rpcError("status", error);
    }
  }

  async snapshot(): Promise<ManagedRuntimeState> {
    const result: ManagedRuntimeState = {
      sessionId: this.sessionId, ready: Boolean(this.session) && !this.closed,
      requests: [...this.pending.values()].map((entry) => entry.request),
      mcp: [], mcpError: null, thirdPartyEnabled: null,
    };
    if (!result.ready) return result;
    try {
      const { servers, host } = await this.mcpState();
      const names = new Map<string, string>(servers.map((server) => [server.name, server.status]));
      for (const name of host?.pendingConnections ?? []) names.set(name, "connecting");
      for (const name of Object.keys(host?.failedServers ?? {})) names.set(name, "failed");
      for (const name of host?.clients ?? []) names.set(name, "connected");
      for (const name of Object.keys(host?.needsAuthServers ?? {})) names.set(name, "needs-auth");
      for (const name of host?.disabledServers ?? []) names.set(name, "disabled");
      for (const name of host?.filteredServers ?? []) names.set(name, "policy-filtered");
      const builtins = new Set(servers.filter((server) => server.source === "builtin").map((server) => server.name));
      result.mcp = [...names].map(([name, status]) => ({
        name, status,
        authentication: builtins.has(name) ? name === "github-mcp-server" ? "copilot-account" : "native"
          : status === "needs-auth" ? !this.nativeMcpSignIn ? "terminal"
            : this.entraHostRequired.has(name) ? "entra-host-required" : "oauth" : "none",
      }));
      result.thirdPartyEnabled = host?.mcp3pEnabled ?? null;
    } catch (error) {
      if (!(error instanceof RuntimeControlError)) throw error;
      result.mcpError = error.message;
    }
    return result;
  }

  async mcpAction(action: "mcp-login" | "mcp-tools" | "mcp-reload", serverName?: string) {
    const session = this.activeSession();
    if (action !== "mcp-reload") {
      const state = await this.snapshot();
      if (state.mcpError) throw new RuntimeControlError(502, state.mcpError);
      const server = state.mcp.find((item) => item.name === serverName);
      if (!server) throw new RuntimeControlError(409, "This MCP server is not registered in the current session.");
      if (server.status === "disabled" || server.status === "policy-filtered") {
        throw new RuntimeControlError(403, "This MCP server is disabled or restricted by policy.");
      }
      if (action === "mcp-login") {
        if (server.authentication === "copilot-account") {
          throw new RuntimeControlError(409, "This built-in MCP uses your Copilot account, not a separate MCP OAuth sign-in. Use Verify tools to check the connection. If account authentication is required, use copilot login in Terminal.");
        }
        if (server.authentication === "native") {
          throw new RuntimeControlError(409, "This built-in MCP uses native Copilot authentication, not a separate generic MCP OAuth sign-in. Use its supported authentication flow in Terminal.");
        }
        if (server.authentication === "terminal" || server.authentication === "entra-host-required") {
          throw terminalMcpAuthError();
        }
        if (server.status === "connected") {
          throw new RuntimeControlError(409, "This MCP server is already connected. Use Verify tools; no separate sign-in is currently required.");
        }
        if (server.authentication !== "oauth" || server.status !== "needs-auth") {
          throw new RuntimeControlError(409, "Copilot has not reported that this MCP server needs OAuth sign-in. Reload native MCP to refresh its state, or inspect its supported authentication setup in Terminal.");
        }
      }
    }
    if (this.activeSession() !== session) throw new RuntimeControlError(409, "The session changed while the MCP action was being prepared.");
    try {
      if (action === "mcp-reload") {
        await session.rpc.mcp.reload();
        return { reloaded: true };
      }
      if (action === "mcp-tools") {
        const result = await session.rpc.mcp.listTools({ serverName: serverName! });
        return { tools: result.tools.map((tool) => tool.name) };
      }
      const result = await session.rpc.mcp.oauth.login({ serverName: serverName! });
      return { authorizationUrl: result.authorizationUrl ? safeRuntimeUrl(result.authorizationUrl) : null };
    } catch (error) {
      if (error instanceof RuntimeControlError) throw error;
      if (action === "mcp-login" && requiresEntraHost(error) && this.session === session) this.entraHostRequired.add(serverName!);
      throw rpcError(action === "mcp-login" ? "sign-in" : action === "mcp-tools" ? "tools/list" : "reload", error);
    }
  }
}

const globalForRuntime = globalThis as typeof globalThis & { workBoardManagedRuntimes?: Map<string, ManagedRuntime> };
const runtimes = globalForRuntime.workBoardManagedRuntimes ??= new Map<string, ManagedRuntime>();
export function getManagedRuntime(runId: string) { return runtimes.get(runId); }
export function registerManagedRuntime(runId: string, runtime: ManagedRuntime) { runtimes.set(runId, runtime); }
export function unregisterManagedRuntime(runId: string, runtime: ManagedRuntime) {
  if (runtimes.get(runId) === runtime) { runtime.close(); runtimes.delete(runId); }
}
