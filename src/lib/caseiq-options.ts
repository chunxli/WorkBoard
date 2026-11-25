import { z } from "zod";
import { nativeMcpServerNameSchema, nativeMcpToolNameSchema } from "../../scripts/native-mcp-permissions.mjs";

export const CASEIQ_MAX_PACKS = 32;

export function caseIqMcpConfigurationHref(workId: string, sessionId?: string | null): string {
  const query = new URLSearchParams({ panel: "mcp" });
  if (sessionId) query.set("sessionId", sessionId);
  return `/work/${encodeURIComponent(workId)}?${query}`;
}

export const caseIqLaunchSchema = z.object({
  packs: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)).max(CASEIQ_MAX_PACKS).default([]),
  caseNumber: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/).nullable().default(null),
  sendPrompt: z.boolean().default(false),
}).strict();

export type CaseIqLaunchOptions = z.infer<typeof caseIqLaunchSchema>;

export const caseIqLastSessionSchema = z.object({
  runId: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.iso.datetime(),
  resumeState: z.enum(["active", "ready", "unavailable"]),
  reason: z.string().nullable(),
  configuration: z.object({
    packs: z.array(z.string()),
    caseNumber: z.string().nullable(),
  }).strict().nullable(),
}).strict();

export type CaseIqLastSession = z.infer<typeof caseIqLastSessionSchema>;

export const caseIqTerminalReceiptSchema = z.object({
  runId: z.string().min(1),
  launcherPid: z.number().int().positive().nullable(),
}).strict();

export type CaseIqTerminalReceipt = z.infer<typeof caseIqTerminalReceiptSchema>;

const pendingTerminalSchema = z.object({
  requestId: z.uuid(),
  action: z.enum(["new", "resume"]),
}).strict();

export type CaseIqPendingTerminal = z.infer<typeof pendingTerminalSchema>;

type TerminalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function caseIqPendingTerminalKey(workId: string): string {
  return `workboard:caseiq:pending:${encodeURIComponent(workId)}`;
}

export function readCaseIqPendingTerminal(storage: Pick<TerminalStorage, "getItem">, workId: string): CaseIqPendingTerminal | null {
  const value = storage.getItem(caseIqPendingTerminalKey(workId));
  return value === null ? null : pendingTerminalSchema.parse(JSON.parse(value));
}

export function rememberCaseIqPendingTerminal(storage: TerminalStorage, workId: string, request: CaseIqPendingTerminal): void {
  if (readCaseIqPendingTerminal(storage, workId)) {
    throw new Error("A previous CaseIQ request is still unconfirmed. Check Terminal and Run history before allowing another attempt.");
  }
  storage.setItem(caseIqPendingTerminalKey(workId), JSON.stringify(pendingTerminalSchema.parse(request)));
}

export function clearCaseIqPendingTerminal(storage: TerminalStorage, workId: string, requestId: string): boolean {
  const pending = readCaseIqPendingTerminal(storage, workId);
  if (pending && pending.requestId !== requestId) return false;
  if (pending) storage.removeItem(caseIqPendingTerminalKey(workId));
  return true;
}

type CaseIqTerminalResponse =
  | { state: "accepted"; receipt: CaseIqTerminalReceipt }
  | { state: "rejected" | "unconfirmed"; message: string };

export function classifyCaseIqTerminalResponse(status: number, content: string): CaseIqTerminalResponse {
  const rejected = status >= 400 && status < 500 && status !== 408;
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      state: rejected ? "rejected" : "unconfirmed",
      message: `CaseIQ returned an invalid response (HTTP ${status}).`,
    };
  }
  const receipt = caseIqTerminalReceiptSchema.safeParse(value);
  if (status >= 200 && status < 300 && receipt.success) return { state: "accepted", receipt: receipt.data };
  const failure = z.object({ error: z.string().min(1) }).safeParse(value);
  return {
    state: rejected ? "rejected" : "unconfirmed",
    message: failure.success ? failure.data.error : `CaseIQ Terminal acceptance was not confirmed (HTTP ${status}).`,
  };
}

export const caseIqStatusSchema = z.object({
  launchable: z.boolean(),
  configured: z.boolean(),
  reason: z.string().nullable(),
  sourceCommit: z.string().nullable(),
  compatibilityKey: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  lastSession: caseIqLastSessionSchema.nullable().optional(),
  packs: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  warnings: z.array(z.string()),
  webExecution: z.object({
    supported: z.boolean(), reason: z.string(), fallback: z.enum(["none", "native-terminal"]),
  }).strict(),
}).strict();

export type CaseIqStatus = z.infer<typeof caseIqStatusSchema>;

export function isCaseIqAuthenticationCommand(text: string): boolean {
  return /^\/mcp\s+auth\s+supportiq$/i.test(text.trim());
}
export const CASEIQ_AUTHENTICATION_COMMAND = "/mcp auth SupportIQ";

export const caseIqAuthenticationOperationSchema = z.object({
  id: z.uuid(), sessionId: z.uuid(), sourceRunId: z.string().min(1), startedAt: z.iso.datetime(),
  status: z.enum(["opening", "active", "closed", "failed", "unconfirmed"]),
  reserved: z.boolean(), message: z.string(),
  phase: z.enum(["preparing", "native-started"]).optional(),
  trustWorkFolder: z.boolean().optional(),
  automatic: z.boolean().optional(),
}).strict();

export const caseIqCredentialManagerStatusSchema = z.object({
  supported: z.boolean(),
  quotaExceeded: z.boolean(),
  writeFailureDetected: z.boolean(),
  lastWriteFailureAt: z.iso.datetime().nullable(),
  totalCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  staleCopilotCount: z.number().int().nonnegative(),
  staleCopilotBytes: z.number().int().nonnegative(),
  staleMaxAgeDays: z.number().int().positive(),
}).strict();

export type CaseIqCredentialManagerStatus = z.infer<typeof caseIqCredentialManagerStatusSchema>;

export const caseIqCredentialManagerCleanupSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative(),
  remainingCount: z.number().int().nonnegative(),
  remainingBytes: z.number().int().nonnegative(),
  remainingStaleCopilotCount: z.number().int().nonnegative(),
  remainingStaleCopilotBytes: z.number().int().nonnegative(),
  staleMaxAgeDays: z.number().int().positive(),
}).strict();

export type CaseIqCredentialManagerCleanup = z.infer<typeof caseIqCredentialManagerCleanupSchema>;

export const caseIqAuthenticationStatusSchema = z.object({
  sessionId: z.uuid().optional(),
  available: z.boolean(), blockedReason: z.string().nullable(),
  authenticationVerified: z.boolean(),
  oauthStorage: z.object({
    mode: z.enum(["shared", "session"]),
    reason: z.enum(["shared-directory-unavailable", "supportiq-profile-unavailable", "local-cache-preserved", "unsafe-cache-path"]).nullable(),
  }).strict().optional(),
  connection: z.object({
    status: z.enum(["connected", "needs-auth", "failed", "pending", "disabled", "not-configured", "unknown"]),
    toolCount: z.number().int().nonnegative().nullable(), checkedAt: z.iso.datetime().nullable(),
  }).strict().optional(),
  credentialManager: caseIqCredentialManagerStatusSchema.optional(),
  credentialCleanup: caseIqCredentialManagerCleanupSchema.optional(),
  operation: caseIqAuthenticationOperationSchema.nullable(),
  automaticSignIn: z.object({
    requestId: z.uuid(), requiredAt: z.iso.datetime({ offset: true }), attempted: z.boolean(),
  }).strict().nullable().optional(),
}).strict();

export type CaseIqAuthenticationOperation = z.infer<typeof caseIqAuthenticationOperationSchema>;
export type CaseIqAuthenticationStatus = z.infer<typeof caseIqAuthenticationStatusSchema>;

export const caseIqSupportIqToolNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/);
export const caseIqRequestedToolNamesSchema = z.array(caseIqSupportIqToolNameSchema).min(1).max(64)
  .refine((tools) => new Set(tools).size === tools.length);
export type CaseIqToolPermissionDecision =
  | { toolName: string; approved: boolean }
  | { action: "approve-requested"; toolNames: string[] }
  | { action: "set-automatic"; enabled: boolean };
export const caseIqToolPermissionStatusSchema = z.object({
  sessionId: z.uuid(), available: z.boolean(), blockedReason: z.string().nullable(),
  autoApproveSupportIq: z.boolean().default(false),
  tools: z.array(z.object({
    name: caseIqSupportIqToolNameSchema, approved: z.boolean(), managed: z.boolean(),
  }).strict()).max(64),
}).strict();
export type CaseIqToolPermissionStatus = z.infer<typeof caseIqToolPermissionStatusSchema>;

export const caseIqMcpServerNameSchema = nativeMcpServerNameSchema;
export const caseIqMcpToolNameSchema = nativeMcpToolNameSchema;
export const caseIqMcpRequestedToolsSchema = z.array(caseIqMcpToolNameSchema).min(1).max(64)
  .refine((tools) => new Set(tools).size === tools.length);
export const caseIqMcpPermissionStatusSchema = z.object({
  sessionId: z.uuid(), available: z.boolean(), blockedReason: z.string().nullable(),
  servers: z.array(z.object({
    serverName: caseIqMcpServerNameSchema, autoApprove: z.boolean(),
    tools: z.array(z.object({
      name: caseIqMcpToolNameSchema, approved: z.boolean(), managed: z.boolean(),
    }).strict()).max(64),
  }).strict()).max(64),
}).strict();
export type CaseIqMcpPermissionStatus = z.infer<typeof caseIqMcpPermissionStatusSchema>;
export type CaseIqMcpPermissionDecision =
  | { serverName: string; toolName: string; approved: boolean }
  | { serverName: string; action: "approve-requested"; toolNames: string[] }
  | { serverName: string; action: "set-automatic"; enabled: boolean };

export const caseIqMcpDefaultsSchema = z.object({
  defaultAutoApprove: z.boolean(),
  servers: z.array(z.object({
    serverName: caseIqMcpServerNameSchema, autoApprove: z.boolean(),
  }).strict()).max(64).refine((servers) => new Set(servers.map((server) => server.serverName)).size === servers.length),
}).strict();
export type CaseIqMcpDefaults = z.infer<typeof caseIqMcpDefaultsSchema>;
export const caseIqMcpDefaultsStatusSchema = z.object({
  settings: caseIqMcpDefaultsSchema, knownServers: z.array(caseIqMcpServerNameSchema).max(64),
  available: z.boolean(), blockedReason: z.string().nullable(), warnings: z.array(z.string()),
  credentialManager: caseIqCredentialManagerStatusSchema.nullable().optional(),
  credentialCleanup: caseIqCredentialManagerCleanupSchema.optional(),
}).strict();
export const caseIqMcpSessionIndexSchema = z.object({
  sessions: z.array(z.object({
    workId: z.string().min(1), workName: z.string(), runId: z.string().min(1), sessionId: z.uuid(),
    createdAt: z.iso.datetime(), ready: z.boolean(), reason: z.string().nullable(),
  }).strict()),
}).strict();
export type CaseIqMcpSessionEntry = z.infer<typeof caseIqMcpSessionIndexSchema>["sessions"][number];

export const CASEIQ_WEB_LIMITATION =
  "Select CaseIQ in Runtime and use Create & Run or Execute. Output, Follow Up, Queue, cancellation and timeout stay in WorkBoard through the original CaseIQ launcher. Sign-in and tool approval are separate: approve requested MCP tools individually/in batches, or explicitly enable automatic approval for one MCP in this Work/session. Other CaseIQ permissions remain in force; interactive authentication is not answered automatically.";
