import path from "node:path";
import { z } from "zod";
import { canonicalMcpApprovals, nativeMcpApprovalsSchema } from "./native-mcp-permissions.mjs";

export const NATIVE_BRIDGE_PROTOCOL = "workboard-native/1";
export const MAX_BRIDGE_FILE_BYTES = 4 * 1024 * 1024;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().min(1).refine(
  (value) => path.isAbsolute(value) && !value.includes("\0"),
  "An absolute path is required.",
);
const option = z.string().min(1).max(512).nullable().default(null);
export const nativeSupportIqToolNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/);

export const nativeOAuthStorageSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("shared"), profileId: digest, reason: z.null() }).strict(),
  z.object({
    mode: z.literal("session"), profileId: z.null(),
    reason: z.enum(["shared-directory-unavailable", "supportiq-profile-unavailable", "local-cache-preserved", "unsafe-cache-path"]),
  }).strict(),
]);

export const nativeBridgeRequestSchema = z.object({
  protocolVersion: z.literal(NATIVE_BRIDGE_PROTOCOL),
  requestId: identifier,
  runId: identifier,
  attemptId: identifier,
  nonce: z.uuid(),
  launcherPath: absolutePath,
  launcherSha256: digest,
  nativeExecutable: absolutePath,
  nativeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  sourceBranch: z.string().nullable().optional(),
  sourceDirty: z.boolean().optional(),
  workingDirectory: absolutePath,
  sharedInputDirectory: absolutePath.optional(),
  sessionId: z.uuid(),
  mode: z.enum(["prompt", "terminal"]).default("prompt"),
  trackPromptWrapper: z.literal(true).optional(),
  authenticationOnly: z.boolean().optional(),
  trustWorkFolder: z.boolean().optional(),
  sharedOAuth: z.object({
    root: absolutePath.nullable(), sessionRoot: absolutePath, boundHome: absolutePath.nullable(),
  }).strict().optional(),
  approvedMcpTools: z.array(nativeSupportIqToolNameSchema).max(64)
    .refine((tools) => new Set(tools).size === tools.length).optional(),
  autoApproveSupportIq: z.boolean().optional(),
  mcpToolApprovals: nativeMcpApprovalsSchema.optional(),
  disableNativeAutoUpdate: z.boolean().optional(),
  sendPrompt: z.boolean().default(true),
  resume: z.boolean().default(false),
  prompt: z.string(),
  terminalLaunchFile: absolutePath.nullable().default(null),
  packs: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)).max(32).default([]),
  caseNumber: z.string().min(1).max(200).regex(/^[^\r\n\0]+$/).nullable().default(null),
  attachments: z.array(absolutePath).max(10).default([]),
  model: option,
  agent: option,
  contextTier: z.enum(["default", "long_context"]).nullable().default(null),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable().default(null),
  handshakeTimeoutMs: z.number().int().min(50).max(60_000).default(10_000),
  timeoutMs: z.number().int().min(50).max(86_400_000).nullable().default(null),
  testExecutableArgs: z.array(z.string()).max(8).default([]),
}).strict();

export const validatedBridgeRequestSchema = nativeBridgeRequestSchema.extend({
  requestDirectory: absolutePath,
  validatedAt: z.number().int().positive(),
}).strict();

export const nativeBridgeInvocationSchema = z.object({
  requestFile: absolutePath,
  nativeArguments: z.array(z.string()).min(1),
  home: absolutePath,
  launchId: identifier,
  caseNumber: z.string().nullable(),
  workingDirectory: absolutePath,
  instructionDirectories: z.array(absolutePath),
  observedVersion: z.string(),
}).strict();

export const preparedBindingSchema = z.object({
  home: absolutePath,
  launchId: identifier,
  caseNumber: z.string().nullable(),
  workingDirectory: absolutePath,
  sessionId: z.uuid(),
  resume: z.boolean(),
  nativeVersion: z.string(),
  launcherSha256: digest,
  pluginDirectories: z.array(absolutePath),
  additionalMcpConfigs: z.array(absolutePath),
  instructionDirectories: z.array(absolutePath),
  allowTools: z.array(z.string()),
  model: z.string().nullable(),
  modelSource: z.enum(["caller", "launcher-default", "native-default"]),
  oauthStorage: nativeOAuthStorageSchema.optional(),
  argumentsHash: digest,
  preparedHash: digest,
}).strict();

const correlation = {
  protocolVersion: z.literal(NATIVE_BRIDGE_PROTOCOL),
  requestId: identifier,
  runId: identifier,
  attemptId: identifier,
  nonce: z.uuid(),
};

const frame = {
  ...correlation,
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
};

export const nativeBridgeFrameSchema = z.discriminatedUnion("kind", [
  z.object({ ...frame, kind: z.literal("prepared"), binding: preparedBindingSchema }).strict(),
  z.object({ ...frame, kind: z.literal("native-spawn"), pid: z.number().int().positive() }).strict(),
  z.object({
    ...frame, kind: z.literal("native-output"),
    stream: z.enum(["stdout", "stderr"]), data: z.string(),
  }).strict(),
  z.object({
    ...frame, kind: z.literal("native-result"),
    pid: z.number().int().positive().nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    cancelled: z.boolean(),
    timedOut: z.boolean(),
    forced: z.boolean(),
    error: z.object({ kind: z.string(), message: z.string() }).strict().nullable(),
  }).strict(),
]);

export const nativeBridgeAcceptanceSchema = z.object({
  ...correlation, action: z.literal("accept"), preparedHash: digest,
}).strict();

export const nativeAuthenticationStatusSchema = z.object({
  ...correlation, sessionId: z.uuid(), preparedHash: digest, checkedAt: z.iso.datetime(),
  status: z.enum(["connected", "needs-auth", "failed", "pending", "disabled", "not-configured", "unknown"]),
  toolCount: z.number().int().nonnegative().nullable(), errorKind: z.string().nullable(),
}).strict().refine((value) => value.status !== "connected" ||
  value.toolCount !== null && value.toolCount > 0 && value.errorKind === null);

export const nativeBridgeCancellationSchema = z.object({
  ...correlation, action: z.literal("cancel"), reason: z.enum(["user", "timeout", "shutdown"]),
}).strict();

export const promptWrapperIdentitySchema = z.object({
  ...correlation,
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^[1-9]\d{0,18}$/),
}).strict();

export const nativeOAuthProbeStatusSchema = z.object({
  ...correlation, sessionId: z.uuid(), preparedHash: digest, checkedAt: z.iso.datetime(),
  status: z.enum(["authenticated", "no-auth-required", "needs-auth", "failed", "unknown"]),
  reason: z.enum(["initial", "refresh", "upscope"]).nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  errorKind: z.string().nullable(),
}).strict();

export const launcherResultSchema = z.object({
  ...correlation,
  launcherExitCode: z.number().int(),
  nativeExitCode: z.number().int().nullable(),
  bridgeExitCode: z.number().int(),
  scriptError: z.boolean(),
  nativeExecutionObserved: z.boolean().nullable(),
  errorKind: z.string().nullable(),
}).strict();

export class NativeBridgeError extends Error {
  constructor(kind, message, options) {
    super(message, options);
    this.name = "NativeBridgeError";
    this.kind = kind;
  }
}

export function bridgeCorrelation(request) {
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    runId: request.runId,
    attemptId: request.attemptId,
    nonce: request.nonce,
  };
}

export function nativeBridgeMcpApprovals(request) {
  if (request.mcpToolApprovals !== undefined) {
    if (request.approvedMcpTools?.length || request.autoApproveSupportIq) {
      throw new NativeBridgeError("unsupported-option", "Legacy and generic MCP approval formats cannot be mixed.");
    }
    return canonicalMcpApprovals(request.mcpToolApprovals);
  }
  return canonicalMcpApprovals([{
    serverName: "SupportIQ", approvedTools: request.approvedMcpTools ?? [], autoApprove: Boolean(request.autoApproveSupportIq),
  }]);
}

export function assertBridgeCorrelation(value, request) {
  for (const [key, expected] of Object.entries(bridgeCorrelation(request))) {
    if (value[key] !== expected) {
      throw new NativeBridgeError("protocol-error", `Bridge ${key} does not match this attempt.`);
    }
  }
}

export function parseNativeBridgeRequest(value, environment = process.env) {
  const request = nativeBridgeRequestSchema.parse(value);
  if (request.trackPromptWrapper && request.mode !== "prompt") {
    throw new NativeBridgeError("unsupported-option", "Prompt wrapper tracking requires Prompt mode.");
  }
  if (request.sharedInputDirectory) {
    const relative = path.relative(request.sharedInputDirectory, request.workingDirectory);
    if (request.mode !== "prompt" || request.authenticationOnly || !relative ||
        relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new NativeBridgeError("unsupported-option", "The paired input must contain the native Prompt output directory.");
    }
  }
  if (request.authenticationOnly && (request.mode !== "terminal" || !request.resume ||
      request.sendPrompt || request.prompt !== "" || request.attachments.length)) {
    throw new NativeBridgeError("unsupported-option", "Authentication must resume the original native session without a task prompt or attachments.");
  }
  if (request.trustWorkFolder && !request.authenticationOnly) {
    throw new NativeBridgeError("unsupported-option", "Folder trust is only available for an explicitly approved authentication operation.");
  }
  if (nativeBridgeMcpApprovals(request).length && (request.mode !== "prompt" || request.authenticationOnly)) {
    throw new NativeBridgeError("unsupported-option", "Scoped MCP tool approvals are only available for native web Prompt runs.");
  }
  if (request.mode === "prompt" && !request.prompt.trim()) {
    throw new NativeBridgeError("unsupported-option", "Prompt-mode execution requires a prompt.");
  }
  if (request.mode === "terminal" && request.attachments.length) {
    throw new NativeBridgeError("unsupported-option", "Interactive attachments must be supplied in native Terminal.");
  }
  if (request.mode === "terminal" && request.sendPrompt && request.prompt.length > 20_000) {
    throw new NativeBridgeError("unsupported-option", "Open CaseIQ without automatic Prompt delivery for long Prompts.");
  }
  if (request.testExecutableArgs.length && environment.NODE_ENV !== "test") {
    throw new NativeBridgeError("unsupported-option", "Executable argument overrides are test-only.");
  }
  return request;
}
