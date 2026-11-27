import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { WINDOWS_PROCESS_START_TIME, readWindowsProcessStartTime, windowsProcessMatchesStartTime } from "@/lib/copilot-process";
import { processIsAlive } from "@/lib/copilot-session-compat";
import { getCaseIqSharedOAuthRoot, getCaseIqStateRoot, pathIsWithin } from "@/lib/native-runtime-paths";
import type { CaseIqAuthenticationOperation } from "@/lib/caseiq-options";
import type { NativeSessionBinding } from "@/lib/native-session-bindings";
import {
  MAX_BRIDGE_FILE_BYTES, assertBridgeCorrelation, bridgeCorrelation, launcherResultSchema, nativeBridgeAcceptanceSchema,
  nativeAuthenticationStatusSchema, nativeOAuthProbeStatusSchema, nativeBridgeFrameSchema, parseNativeBridgeRequest,
} from "../../scripts/native-bridge-protocol.mjs";

const operationSchema = z.object({
  id: z.uuid(), sessionId: z.uuid(), sourceRunId: z.string().min(1), startedAt: z.iso.datetime(),
  userId: z.string().min(1), workId: z.string().min(1), hostname: z.string().min(1),
  launchRejected: z.boolean().default(false), errorMessage: z.string().nullable().default(null),
  trustWorkFolder: z.boolean().default(false),
  automatic: z.boolean().optional(),
}).strict();
export type StoredCaseIqAuthentication = z.infer<typeof operationSchema>;
const stoppedSchema = nativeBridgeAcceptanceSchema.extend({
  action: z.literal("authentication-stopped"), sessionId: z.uuid(), nativePid: z.number().int().positive(),
  wrapperPid: z.number().int().positive(), wrapperStartTime: z.string().regex(WINDOWS_PROCESS_START_TIME),
  checkedAt: z.iso.datetime(),
}).strict();

async function authenticationNativeStopped(spawn: { pid: number; timestamp: string }) {
  if (!processIsAlive(spawn.pid)) return true;
  if (process.platform !== "win32") return false;
  const started = await readWindowsProcessStartTime(spawn.pid);
  if (started === null) return true;
  const milliseconds = Number((BigInt(started) - BigInt("116444736000000000")) / BigInt(10000));
  return milliseconds > Date.parse(spawn.timestamp) + 5000;
}

export function caseIqAuthenticationDirectory(): string {
  return path.join(getCaseIqStateRoot(), "authentication");
}

function operationFile(workId: string): string {
  const name = createHash("sha256").update(workId).digest("hex");
  return path.join(caseIqAuthenticationDirectory(), `${name}.json`);
}

export async function readCaseIqAuthenticationJson(file: string): Promise<unknown | null> {
  let info;
  try { info = await lstat(/* turbopackIgnore: true */ file); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BRIDGE_FILE_BYTES) {
    throw new Error("CaseIQ authentication metadata is not a bounded regular file.");
  }
  return JSON.parse(await readFile(/* turbopackIgnore: true */ file, "utf8"));
}

export async function readCaseIqAuthentication(workId: string): Promise<StoredCaseIqAuthentication | null> {
  const value = await readCaseIqAuthenticationJson(operationFile(workId));
  if (value === null) return null;
  const operation = operationSchema.parse(value);
  if (operation.workId !== workId || operation.hostname !== hostname()) {
    throw new Error("CaseIQ authentication metadata belongs to another Work or host.");
  }
  return operation;
}

async function readAuthenticationInvocation(operation: StoredCaseIqAuthentication) {
  const directory = path.join(getCaseIqStateRoot(), "requests", operation.id);
  const requestValue = await readCaseIqAuthenticationJson(path.join(directory, "request.json"));
  const acceptanceValue = await readCaseIqAuthenticationJson(path.join(directory, "accept.json"));
  const file = path.join(directory, "journal.jsonl");
  let journal: string;
  try {
    const info = await lstat(/* turbopackIgnore: true */ file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BRIDGE_FILE_BYTES) {
      throw new Error("Authentication journal is not a bounded regular file.");
    }
    journal = await readFile(/* turbopackIgnore: true */ file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (requestValue === null || acceptanceValue === null) return null;
  const request = parseNativeBridgeRequest(requestValue);
  const acceptance = nativeBridgeAcceptanceSchema.parse(acceptanceValue);
  assertBridgeCorrelation(acceptance, request);
  if (!request.authenticationOnly || request.runId !== operation.id || request.sessionId !== operation.sessionId ||
      Boolean(request.trustWorkFolder) !== operation.trustWorkFolder) {
    throw new Error("Authentication request belongs to another operation.");
  }
  const complete = journal.slice(0, journal.lastIndexOf("\n") + 1);
  const frames = complete.split("\n").filter(Boolean).map((line) => nativeBridgeFrameSchema.parse(JSON.parse(line)));
  frames.forEach((frame, index) => {
    assertBridgeCorrelation(frame, request);
    if (frame.sequence !== index + 1) throw new Error("Authentication journal sequence is invalid.");
  });
  const preparations = frames.filter((frame) => frame.kind === "prepared");
  const spawns = frames.filter((frame) => frame.kind === "native-spawn");
  if (preparations.length > 1 || spawns.length > 1) {
    throw new Error("Authentication journal contains multiple native invocations.");
  }
  const prepared = preparations[0];
  const spawn = spawns[0];
  if (prepared && (prepared.binding.preparedHash !== acceptance.preparedHash ||
      prepared.binding.sessionId !== request.sessionId || !prepared.binding.resume ||
      spawn && spawn.sequence <= prepared.sequence)) {
    throw new Error("Authentication binding does not match the accepted session.");
  }
  return prepared && spawn ? { request, prepared, spawn } : null;
}

const observerCleanups = new Map<string, Promise<void>>();

async function removeStoppedAuthenticationObserver(operation: StoredCaseIqAuthentication) {
  const current = observerCleanups.get(operation.id);
  if (current) return current;
  const cleanup = cleanStoppedAuthenticationObserver(operation);
  observerCleanups.set(operation.id, cleanup);
  try { await cleanup; }
  finally { observerCleanups.delete(operation.id); }
}

async function cleanStoppedAuthenticationObserver(operation: StoredCaseIqAuthentication) {
  const invocation = await readAuthenticationInvocation(operation);
  if (!invocation || !await authenticationNativeStopped(invocation.spawn)) return;
  const { request, prepared } = invocation;
  const directory = path.join(prepared.binding.home, "extensions", `workboard-auth-${request.attemptId}`);
  let info;
  try { info = await lstat(/* turbopackIgnore: true */ directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const nativeRoot = await realpath(/* turbopackIgnore: true */ path.join(getCaseIqStateRoot(), "native", operation.sessionId));
  const home = await realpath(/* turbopackIgnore: true */ prepared.binding.home);
  const parent = await lstat(/* turbopackIgnore: true */ path.dirname(directory));
  if (!pathIsWithin(nativeRoot, home) || !info.isDirectory() || info.isSymbolicLink() ||
      !parent.isDirectory() || parent.isSymbolicLink() ||
      await realpath(/* turbopackIgnore: true */ directory) !== directory) {
    throw new Error("Stopped authentication observer directory is unsafe.");
  }
  const context = z.object({
    correlation: z.record(z.string(), z.string()), sessionId: z.uuid(),
    preparedHash: z.string(), requestDirectory: z.string(),
  }).strict().parse(await readCaseIqAuthenticationJson(path.join(directory, "context.json")));
  const acceptance = nativeBridgeAcceptanceSchema.parse({
    ...context.correlation, action: "accept", preparedHash: context.preparedHash,
  });
  assertBridgeCorrelation(acceptance, request);
  if (context.sessionId !== operation.sessionId || context.preparedHash !== prepared.binding.preparedHash ||
      context.requestDirectory !== path.join(getCaseIqStateRoot(), "requests", operation.id)) {
    throw new Error("Stopped authentication observer belongs to another operation.");
  }
  const entries = await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !["context.json", "extension.mjs"].includes(entry.name))) {
    throw new Error("Stopped authentication observer contains unexpected files.");
  }
  await rm(/* turbopackIgnore: true */ directory, { recursive: true });
}

export async function readCaseIqNativeConnection(
  operation: StoredCaseIqAuthentication,
  currentStorage?: NativeSessionBinding["oauthStorage"],
  options: { allowTransientLauncherReset?: boolean } = {},
) {
  const unknown = { status: "unknown" as const, toolCount: null, checkedAt: null };
  const directory = path.join(getCaseIqStateRoot(), "requests", operation.id);
  const value = await readCaseIqAuthenticationJson(path.join(directory, "mcp-status.json"));
  if (value === null) return unknown;
  const observation = nativeAuthenticationStatusSchema.parse(value);
  const invocation = await readAuthenticationInvocation(operation);
  if (!invocation) throw new Error("Native MCP observation has no accepted native invocation.");
  const { request, prepared, spawn } = invocation;
  assertBridgeCorrelation(observation, request);
  if (observation.sessionId !== operation.sessionId || observation.preparedHash !== prepared.binding.preparedHash ||
      Date.parse(observation.checkedAt) < Date.parse(operation.startedAt) ||
      Date.parse(observation.checkedAt) < Date.parse(spawn.timestamp) ||
      Date.parse(observation.checkedAt) > Date.now() + 5000) {
    throw new Error("Native MCP observation does not match the authentication operation.");
  }
  if (currentStorage && (prepared.binding.oauthStorage?.mode !== currentStorage.mode ||
      prepared.binding.oauthStorage?.profileId !== currentStorage.profileId)) return unknown;
  const cache = path.join(prepared.binding.home, "mcp-oauth-config");
  let actualDirectory: string;
  try { actualDirectory = await realpath(/* turbopackIgnore: true */ cache); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return unknown;
    throw error;
  }
  const sharedRoot = getCaseIqSharedOAuthRoot(operation.userId, request.launcherPath);
  let canonicalSharedRoot: string | null = null;
  try { canonicalSharedRoot = await realpath(/* turbopackIgnore: true */ sharedRoot); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (canonicalSharedRoot && pathIsWithin(canonicalSharedRoot, actualDirectory)) {
    const [profileId, name, extra] = path.relative(canonicalSharedRoot, actualDirectory).split(path.sep);
    if (extra !== undefined || name !== "mcp-oauth-config" || !/^[a-f0-9]{64}$/.test(profileId) ||
        prepared.binding.oauthStorage?.mode !== "shared" ||
        prepared.binding.oauthStorage.profileId !== profileId) return unknown;
  } else if (prepared.binding.oauthStorage?.mode === "shared") {
    const expectedProfileId = prepared.binding.oauthStorage.profileId;
    if (!options.allowTransientLauncherReset || !canonicalSharedRoot || !expectedProfileId || !/^[a-f0-9]{64}$/.test(expectedProfileId)) {
      return unknown;
    }
    const nativeSessionRoot = await realpath(/* turbopackIgnore: true */ path.join(getCaseIqStateRoot(), "native", operation.sessionId)).catch(() => null);
    const sharedProfileDir = path.join(canonicalSharedRoot, expectedProfileId, "mcp-oauth-config");
    const sharedInfo = await lstat(/* turbopackIgnore: true */ sharedProfileDir).catch(() => null);
    if (!nativeSessionRoot || !pathIsWithin(nativeSessionRoot, actualDirectory) || !sharedInfo?.isDirectory() || sharedInfo.isSymbolicLink()) {
      return unknown;
    }
  }
  if (observation.status !== "connected") {
    return { status: observation.status, toolCount: observation.toolCount, checkedAt: observation.checkedAt };
  }
  const oauthValue = await readCaseIqAuthenticationJson(path.join(directory, "mcp-oauth-probe.json"));
  if (oauthValue === null) return { ...unknown, checkedAt: observation.checkedAt };
  const oauth = nativeOAuthProbeStatusSchema.parse(oauthValue);
  assertBridgeCorrelation(oauth, request);
  if (oauth.sessionId !== operation.sessionId || oauth.preparedHash !== prepared.binding.preparedHash ||
      Date.parse(oauth.checkedAt) < Date.parse(operation.startedAt) ||
      Date.parse(oauth.checkedAt) < Date.parse(spawn.timestamp) ||
      Date.parse(oauth.checkedAt) > Date.now() + 5000) {
    throw new Error("Native OAuth observation does not match the authentication operation.");
  }
  if (oauth.status === "needs-auth") return { status: "needs-auth" as const, toolCount: null, checkedAt: oauth.checkedAt };
  if (oauth.status !== "authenticated" || oauth.errorKind !== null) return { ...unknown, checkedAt: oauth.checkedAt };
  return {
    status: observation.status, toolCount: observation.toolCount,
    checkedAt: new Date(Math.min(Date.parse(observation.checkedAt), Date.parse(oauth.checkedAt))).toISOString(),
  };
}

export async function writeCaseIqAuthentication(operation: StoredCaseIqAuthentication): Promise<void> {
  const value = operationSchema.parse(operation);
  const file = operationFile(value.workId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

const authenticationChecks = new Map<string, Promise<CaseIqAuthenticationOperation>>();

export async function caseIqAuthenticationActivity(operation: StoredCaseIqAuthentication): Promise<CaseIqAuthenticationOperation> {
  const key = JSON.stringify(operation);
  const current = authenticationChecks.get(key);
  if (current) return current;
  const check = inspectCaseIqAuthenticationActivity(operation);
  authenticationChecks.set(key, check);
  try { return await check; }
  finally { authenticationChecks.delete(key); }
}

async function inspectCaseIqAuthenticationActivity(operation: StoredCaseIqAuthentication): Promise<CaseIqAuthenticationOperation> {
  const result = (status: CaseIqAuthenticationOperation["status"], reserved: boolean, message: string) => ({
    id: operation.id, sessionId: operation.sessionId, sourceRunId: operation.sourceRunId,
    startedAt: operation.startedAt, status, reserved, message,
    trustWorkFolder: operation.trustWorkFolder, ...(operation.automatic ? { automatic: true } : {}),
  });
  if (operation.launchRejected) return result("failed", false, operation.errorMessage ?? "The authentication window could not be launched.");
  const directory = path.join(getCaseIqStateRoot(), "requests", operation.id);
  const errorValue = await readCaseIqAuthenticationJson(path.join(directory, "authentication-error.json"));
  const preparationError = errorValue === null ? null : z.object({
    operationId: z.literal(operation.id), message: z.string(),
  }).strict().parse(errorValue).message;
  const metadata = await readCaseIqAuthenticationJson(path.join(directory, "terminal.json"));
  const terminal = metadata === null ? null : z.object({
    wrapperPid: z.number().int().positive().optional(),
    wrapperStartTime: z.string().regex(WINDOWS_PROCESS_START_TIME).optional(),
    exitCode: z.number().int().optional(),
    nativeInvoked: z.boolean().optional(),
  }).passthrough().parse(metadata);
  if (Boolean(terminal?.wrapperPid) !== Boolean(terminal?.wrapperStartTime)) {
    throw new Error("CaseIQ authentication wrapper identity is incomplete.");
  }
  const stoppedFile = path.join(directory, "authentication-stopped.json");
  const recorded = await readCaseIqAuthenticationJson(stoppedFile);
  let stopConfirmed = false;
  if (recorded !== null) {
    const invocation = await readAuthenticationInvocation(operation);
    const stopped = stoppedSchema.parse(recorded);
    if (!invocation) throw new Error("Authentication stop confirmation has no accepted invocation.");
    assertBridgeCorrelation(stopped, invocation.request);
    if (stopped.sessionId !== operation.sessionId || stopped.nativePid !== invocation.spawn.pid ||
        stopped.preparedHash !== invocation.prepared.binding.preparedHash ||
        stopped.wrapperPid !== terminal?.wrapperPid || stopped.wrapperStartTime !== terminal?.wrapperStartTime ||
        Date.parse(stopped.checkedAt) < Date.parse(invocation.spawn.timestamp) ||
        Date.parse(stopped.checkedAt) > Date.now() + 5000) {
      throw new Error("Authentication stop confirmation belongs to another invocation.");
    }
    stopConfirmed = true;
  }
  const alive = !stopConfirmed && terminal?.wrapperPid !== undefined && terminal.wrapperStartTime !== undefined &&
    await windowsProcessMatchesStartTime(terminal.wrapperPid, terminal.wrapperStartTime);
  if (alive) {
    const invocation = await readAuthenticationInvocation(operation);
    return {
      ...result("active", true, preparationError ?? operation.errorMessage ?? (invocation
        ? "In the authentication window, run /mcp auth SupportIQ and select your TSE account. After signing in, exit Copilot and return here."
        : "The authentication window is open. The original CaseIQ launcher is still preparing this Session; wait for its native prompt.")),
      phase: invocation ? "native-started" as const : "preparing" as const,
    };
  }
  const nativeValue = await readCaseIqAuthenticationJson(path.join(directory, "native-result.json"));
  const launcherValue = await readCaseIqAuthenticationJson(path.join(directory, "launcher-result.json"));
  if (terminal?.exitCode !== undefined && terminal.nativeInvoked === false && nativeValue === null && launcherValue !== null) {
    const request = parseNativeBridgeRequest(await readCaseIqAuthenticationJson(path.join(directory, "request.json")));
    const launcher = launcherResultSchema.parse(launcherValue);
    assertBridgeCorrelation(launcher, request);
    if (!request.authenticationOnly || request.runId !== operation.id || request.sessionId !== operation.sessionId ||
        terminal.exitCode !== launcher.bridgeExitCode || !launcher.scriptError) {
      throw new Error("CaseIQ authentication startup failure does not match its owner.");
    }
    return result("failed", false, "CaseIQ setup stopped before invoking the native session. Check the original window or private startup diagnostics before retrying sign-in.");
  }
  if (terminal?.exitCode !== undefined && nativeValue !== null && launcherValue !== null) {
    const request = parseNativeBridgeRequest(await readCaseIqAuthenticationJson(path.join(directory, "request.json")));
    const native = nativeBridgeFrameSchema.parse(nativeValue);
    const launcher = launcherResultSchema.parse(launcherValue);
    assertBridgeCorrelation(native, request);
    assertBridgeCorrelation(launcher, request);
    if (!request.authenticationOnly || request.runId !== operation.id || request.sessionId !== operation.sessionId ||
        native.kind !== "native-result" || launcher.nativeExitCode !== native.exitCode ||
        terminal.exitCode !== launcher.bridgeExitCode) {
      throw new Error("CaseIQ authentication completion does not match its invocation.");
    }
    const failed = launcher.scriptError || native.error !== null || native.timedOut || launcher.bridgeExitCode !== 0;
    if (!stopConfirmed) await removeStoppedAuthenticationObserver(operation);
    if (native.cancelled && !launcher.scriptError && native.error === null && !native.timedOut) {
      return result("closed", false, "The owned authentication window was stopped. This does not verify sign-in, change credentials or replay a Prompt.");
    }
    return result(failed ? "failed" : "closed", false, failed
      ? "The native authentication window ended with an error. Sign-in has not been verified; check the local window output before retrying."
      : "The authentication window has closed. MCP access is not yet independently verified. Continue with a new CaseIQ Prompt; the old Prompt will not be replayed.");
  }
  if (stopConfirmed) {
    return result("closed", false, "The authentication processes were independently confirmed stopped. This does not grant MCP tool execution or replay any Prompt.");
  }
  if (terminal?.wrapperPid !== undefined && terminal.wrapperStartTime !== undefined) {
    const invocation = await readAuthenticationInvocation(operation);
    if (invocation && await authenticationNativeStopped(invocation.spawn)) {
      await removeStoppedAuthenticationObserver(operation);
      const temporary = `${stoppedFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(stoppedSchema.parse({
        ...bridgeCorrelation(invocation.request), action: "authentication-stopped",
        sessionId: operation.sessionId, nativePid: invocation.spawn.pid,
        wrapperPid: terminal.wrapperPid, wrapperStartTime: terminal.wrapperStartTime,
        preparedHash: invocation.prepared.binding.preparedHash, checkedAt: new Date().toISOString(),
      })), { flag: "wx", mode: 0o600 });
      await rename(temporary, stoppedFile);
      return result("closed", false,
        "The recorded authentication processes have stopped, even though their final receipts are incomplete. Follow Up is available again. MCP authorization is still unverified; no Prompt was replayed.");
    }
  }
  const starting = Date.now() - Date.parse(operation.startedAt) < 120_000;
  return result(starting ? "opening" : "unconfirmed", true, preparationError ?? operation.errorMessage ?? (starting
    ? "Opening the original CaseIQ authentication window. No task Prompt is sent."
    : "The authentication process stop is unconfirmed. Check the original window and local diagnostics; do not open another session."));
}

export async function caseIqAuthenticationBlockedReason(keys: readonly string[]): Promise<string | null> {
  const works = keys.filter((key) => key.startsWith("work:")).map((key) => key.slice(5));
  const sessions = new Set(keys.filter((key) => key.startsWith("session:")).map((key) => key.slice(8)));
  const operations: StoredCaseIqAuthentication[] = [];
  for (const workId of works) {
    const operation = await readCaseIqAuthentication(workId);
    if (operation) operations.push(operation);
  }
  if (sessions.size) {
    let files: string[];
    try { files = await readdir(/* turbopackIgnore: true */ caseIqAuthenticationDirectory()); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      files = [];
    }
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const value = operationSchema.parse(await readCaseIqAuthenticationJson(path.join(caseIqAuthenticationDirectory(), file)));
      if (sessions.has(value.sessionId)) {
        if (value.hostname !== hostname()) throw new Error("Authentication session metadata belongs to another host.");
        if (!operations.some((operation) => operation.id === value.id)) operations.push(value);
      }
    }
  }
  for (const operation of operations) {
    if ((await caseIqAuthenticationActivity(operation)).reserved) {
      return "Finish the SupportIQ authentication window before starting another Run or Follow Up in this Work/session.";
    }
  }
  return null;
}
