import { randomUUID } from "node:crypto";
import { link, lstat, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CaseIqIntegrationError, caseIqRunAlreadyFinalizing, caseIqStopAlreadyRequested } from "@/lib/caseiq-errors";
import { windowsProcessMatchesStartTime } from "@/lib/copilot-process";
import { jobQueue } from "@/lib/job-queue";
import { getCaseIqStateRoot } from "@/lib/native-runtime-paths";
import type { FinalRunArtifactDigests } from "@/lib/run-artifacts";
import { getWorkRunQueueKey } from "@/lib/work-run-queue";
import {
  MAX_BRIDGE_FILE_BYTES, assertBridgeCorrelation, bridgeCorrelation, launcherResultSchema,
  nativeBridgeAcceptanceSchema, nativeBridgeCancellationSchema, nativeBridgeFrameSchema,
  parseNativeBridgeRequest, promptWrapperIdentitySchema,
} from "../../scripts/native-bridge-protocol.mjs";

type BridgeRequest = ReturnType<typeof parseNativeBridgeRequest>;
type CancellationReason = z.infer<typeof nativeBridgeCancellationSchema>["reason"];

export const CASEIQ_RECOVERY_RESERVED = "CaseIQ process exit is unconfirmed after interruption. This Work remains reserved; use Cancel Run or check the original host and private Run diagnostics.";

interface InterruptedRun {
  id: string;
  hostname: string | null;
  copilotSessionId: string | null;
  executionPath: string | null;
}

const recovery = globalThis as typeof globalThis & { caseIqInterruptedRuns?: Map<string, () => void> };
const interruptedRuns = recovery.caseIqInterruptedRuns ??= new Map<string, () => void>();

export function trackInterruptedCaseIqRun(run: Pick<InterruptedRun, "id" | "copilotSessionId">): void {
  if (!interruptedRuns.has(run.id)) interruptedRuns.set(run.id, jobQueue.hold(getWorkRunQueueKey(run)));
}

export function interruptedCaseIqRunIds(): string[] {
  return [...interruptedRuns.keys()];
}

export function releaseInterruptedCaseIqRun(runId: string): void {
  const release = interruptedRuns.get(runId);
  interruptedRuns.delete(runId);
  release?.();
}

const uuid = z.uuid();
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const launchMarkerSchema = z.object({
  version: z.literal(1), id: uuid, hostname: z.string().min(1), copilotSessionId: uuid, executionPath: z.string(),
}).strict();
const launchDecisionSchema = launchMarkerSchema.extend({ outcome: z.enum(["authorized", "interrupted", "cancelled"]) });
const retryCancellationSchema = nativeBridgeCancellationSchema.extend({ action: z.literal("cancel-retry"), reason: z.literal("user") });
const artifactDigestSchema = z.object({ byteSize: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const completionReceiptSchema = launchMarkerSchema.extend({
  workId: z.string().min(1),
  hasOutput: z.boolean(),
  finalCommit: z.string().nullable(),
  skillInvoked: z.boolean().nullable(),
  artifacts: z.object({ snapshot: artifactDigestSchema, result: artifactDigestSchema }).strict(),
});
type LaunchMarker = z.infer<typeof launchMarkerSchema>;
type LaunchOutcome = z.infer<typeof launchDecisionSchema>["outcome"];
type PrelaunchStop = Exclude<LaunchOutcome, "authorized">;

function localRunMarker(run: InterruptedRun): LaunchMarker {
  if (run.hostname !== hostname() || !run.copilotSessionId || !run.executionPath || !path.isAbsolute(run.executionPath)) {
    throw new CaseIqIntegrationError("Use the original, verified Windows host to recover this CaseIQ Run.", 409);
  }
  return launchMarkerSchema.parse({ version: 1, id: run.id, hostname: run.hostname, copilotSessionId: run.copilotSessionId, executionPath: run.executionPath });
}

function launchDirectory(run: LaunchMarker) {
  return path.join(/* turbopackIgnore: true */ getCaseIqStateRoot(), "web-launches", run.id);
}

export async function readOptionalCaseIqBridgeJson(file: string): Promise<unknown> {
  try {
    const info = await lstat(/* turbopackIgnore: true */ file);
    if (!info.isFile() || info.size > MAX_BRIDGE_FILE_BYTES) {
      throw new Error("CaseIQ bridge state is not a bounded regular file.");
    }
    const value: unknown = JSON.parse(await readFile(/* turbopackIgnore: true */ file, "utf8"));
    if (value === null) throw new Error("CaseIQ bridge state cannot be null.");
    return value;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function publishNewJson(file: string, value: object): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    // One writer can publish a complete record at this destination; later writers cannot replace it.
    await link(temporary, file);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return false;
  } finally {
    await rm(temporary).catch((error: unknown) => console.warn("[CaseIQ] Could not remove a staged lifecycle record.", error));
  }
}

export async function requestCaseIqBridgeCancellation(directory: string, request: BridgeRequest, reason: CancellationReason) {
  const file = path.join(directory, "cancel.json");
  if (await readOptionalCaseIqBridgeJson(file) === null &&
      await publishNewJson(file, { ...bridgeCorrelation(request), action: "cancel", reason })) return reason;
  const recorded = nativeBridgeCancellationSchema.parse(await readOptionalCaseIqBridgeJson(file));
  assertBridgeCorrelation(recorded, request);
  return recorded.reason;
}

function assertLaunchMarkerOwner(record: LaunchMarker, expected: LaunchMarker): void {
  if (record.id !== expected.id || record.hostname !== expected.hostname ||
      record.copilotSessionId !== expected.copilotSessionId || !path.isAbsolute(record.executionPath) ||
      path.relative(record.executionPath, expected.executionPath) !== "") {
    throw new CaseIqIntegrationError("CaseIQ launch evidence belongs to a different Run, Session or workspace.");
  }
}

async function hasPreparedLaunch(directory: string, expected: LaunchMarker): Promise<boolean> {
  const value = await readOptionalCaseIqBridgeJson(path.join(directory, "preparing.json"));
  if (value === null) return false;
  assertLaunchMarkerOwner(launchMarkerSchema.parse(value), expected);
  return true;
}

async function readLaunchDecision(file: string, expected: LaunchMarker): Promise<LaunchOutcome | null> {
  const value = await readOptionalCaseIqBridgeJson(file);
  if (value === null) return null;
  const decision = launchDecisionSchema.parse(value);
  assertLaunchMarkerOwner(decision, expected);
  return decision.outcome;
}

async function ensureLaunchDirectoryIsLocal(directory: string) {
  try {
    if (path.relative(await realpath(/* turbopackIgnore: true */ directory), directory) !== "") {
      throw new CaseIqIntegrationError("CaseIQ launch evidence directory was redirected.");
    }
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export async function prepareCaseIqRunLaunch(run: InterruptedRun, ensurePrivateDirectory: (directory: string) => Promise<void>) {
  const marker = localRunMarker(run);
  const directory = launchDirectory(marker);
  await ensurePrivateDirectory(directory);
  if (!await ensureLaunchDirectoryIsLocal(directory) || await readLaunchDecision(path.join(directory, "decision.json"), marker)) {
    throw new CaseIqIntegrationError("This CaseIQ Run already has a launch decision. Start a new Run explicitly.");
  }
  if (!await publishNewJson(path.join(directory, "preparing.json"), marker) &&
      !await hasPreparedLaunch(directory, marker)) {
    throw new CaseIqIntegrationError("The original CaseIQ preparation changed. No Prompt was sent.");
  }
}

export async function authorizeCaseIqRunLaunch(run: InterruptedRun): Promise<"authorized" | "cancelled"> {
  const marker = localRunMarker(run);
  const directory = launchDirectory(marker);
  const file = path.join(directory, "decision.json");
  if (await ensureLaunchDirectoryIsLocal(directory) && await hasPreparedLaunch(directory, marker)) {
    if (await publishNewJson(file, { ...marker, outcome: "authorized" })) {
      // No preparation proof may survive a launch if the decision file is later missing.
      await rm(path.join(directory, "preparing.json"));
      return "authorized";
    }
    if (await readLaunchDecision(file, marker) === "cancelled") return "cancelled";
  }
  throw new CaseIqIntegrationError("CaseIQ launch is no longer authorized. No Prompt was sent.");
}

export async function sealCaseIqRunCompletion(run: InterruptedRun & { workId: string }, completion: {
  hasOutput: boolean; finalCommit: string | null; skillInvoked: boolean | null; artifacts: FinalRunArtifactDigests;
}): Promise<void> {
  const marker = localRunMarker(run);
  const directory = launchDirectory(marker);
  const receipt = completionReceiptSchema.parse({ ...marker, workId: run.workId, ...completion });
  if (!await ensureLaunchDirectoryIsLocal(directory) ||
      !await publishNewJson(path.join(directory, "completion.json"), receipt)) {
    throw new CaseIqIntegrationError("CaseIQ could not seal a unique completion receipt.");
  }
}

export async function readCaseIqRunCompletion(run: InterruptedRun & { workId: string }) {
  const marker = localRunMarker(run);
  const directory = launchDirectory(marker);
  if (!await ensureLaunchDirectoryIsLocal(directory)) return null;
  const value = await readOptionalCaseIqBridgeJson(path.join(directory, "completion.json"));
  if (value === null) return null;
  const receipt = completionReceiptSchema.parse(value);
  assertLaunchMarkerOwner(receipt, marker);
  if (receipt.workId !== run.workId) throw new Error("CaseIQ completion receipt belongs to a different Work.");
  return receipt;
}

async function sealCaseIqRunBeforeLaunch(marker: LaunchMarker, stop: PrelaunchStop): Promise<PrelaunchStop | null> {
  const directory = launchDirectory(marker);
  if (!await ensureLaunchDirectoryIsLocal(directory)) return null;
  const file = path.join(directory, "decision.json");
  let outcome = await readLaunchDecision(file, marker);
  if (outcome === null && await hasPreparedLaunch(directory, marker)) {
    outcome = await publishNewJson(file, { ...marker, outcome: stop }) ? stop : await readLaunchDecision(file, marker);
  }
  return outcome !== null && outcome !== "authorized" && await hasPreparedLaunch(directory, marker) ? outcome : null;
}

export async function persistCaseIqPrelaunchCancellation(run: InterruptedRun, attempt?: { directory: string; request: BridgeRequest }) {
  try {
    const outcome = await sealCaseIqRunBeforeLaunch(localRunMarker(run), "cancelled");
    if (outcome === "cancelled") return;
    if (outcome === null && attempt?.request.trackPromptWrapper) {
      // Authorization may have won just before cancellation, while the wrapper was still unspawned.
      if (await requestCaseIqBridgeCancellation(attempt.directory, attempt.request, "user") === "user") return;
      throw caseIqStopAlreadyRequested();
    }
    throw new CaseIqIntegrationError("CaseIQ could not verify a cancellable preparation. Refresh the Run for its status.");
  } catch (error) {
    if (error instanceof CaseIqIntegrationError) throw error;
    console.error("[CaseIQ] Could not persist prelaunch cancellation.", run.id, error instanceof Error ? error.name : error);
    throw new CaseIqIntegrationError("CaseIQ could not save the cancellation request. Refresh the Run for its status.", 409, { cause: error });
  }
}

async function hasRetryCancellation(directory: string, request: BridgeRequest): Promise<boolean> {
  const value = await readOptionalCaseIqBridgeJson(path.join(directory, "cancel-retry.json"));
  if (value === null) return false;
  assertBridgeCorrelation(retryCancellationSchema.parse(value), request);
  return true;
}

export async function persistCaseIqRetryCancellation(directory: string, request: BridgeRequest): Promise<void> {
  try {
    if (!await publishNewJson(path.join(directory, "cancel-retry.json"), {
      ...bridgeCorrelation(request), action: "cancel-retry", reason: "user",
    }) && !await hasRetryCancellation(directory, request)) {
      throw new Error("CaseIQ retry cancellation record is missing.");
    }
  } catch (error) {
    console.error("[CaseIQ] Could not persist retry cancellation.", request.runId, error instanceof Error ? error.name : error);
    throw new CaseIqIntegrationError("CaseIQ could not save the cancellation request. Refresh the Run for its status.", 409, { cause: error });
  }
}

export async function readCaseIqAttemptExit(directory: string, request: BridgeRequest) {
  const launcherValue = await readOptionalCaseIqBridgeJson(path.join(directory, "launcher-result.json"));
  if (launcherValue === null) return null;
  const launcher = launcherResultSchema.parse(launcherValue);
  assertBridgeCorrelation(launcher, request);
  const acceptanceValue = await readOptionalCaseIqBridgeJson(path.join(directory, "accept.json"));
  if (acceptanceValue !== null) assertBridgeCorrelation(nativeBridgeAcceptanceSchema.parse(acceptanceValue), request);
  const nativeValue = await readOptionalCaseIqBridgeJson(path.join(directory, "native-result.json"));
  if (nativeValue === null) {
    return acceptanceValue === null && launcher.nativeExecutionObserved === null && launcher.nativeExitCode === null
      ? { launcher, native: null } : null;
  }
  const native = nativeBridgeFrameSchema.parse(nativeValue);
  assertBridgeCorrelation(native, request);
  if (native.kind !== "native-result" || launcher.nativeExitCode !== native.exitCode ||
      launcher.nativeExecutionObserved !== (native.pid !== null)) {
    throw new Error("CaseIQ exit receipts disagree.");
  }
  const stoppedBeforeSpawn = native.pid === null && native.exitCode === null && native.signal === null && !native.forced &&
    (native.error?.kind === "native-spawn-error" || native.error === null && (native.cancelled || native.timedOut));
  if (native.pid !== null && acceptanceValue === null ||
      native.pid === null && acceptanceValue !== null && !stoppedBeforeSpawn) {
    return null;
  }
  return { launcher, native };
}

async function readRecordedWrapper(directory: string, request: BridgeRequest) {
  const value = await readOptionalCaseIqBridgeJson(path.join(directory, "prompt-wrapper.json"));
  if (value === null) return null;
  const wrapper = promptWrapperIdentitySchema.parse(value);
  assertBridgeCorrelation(wrapper, request);
  return wrapper;
}

async function attemptReachedInvocation(directory: string) {
  return await readOptionalCaseIqBridgeJson(path.join(directory, "invocation.json")) !== null ||
    await readOptionalCaseIqBridgeJson(path.join(directory, "accept.json")) !== null;
}

async function readRunAttempts(run: LaunchMarker) {
  const { executionPath } = run;
  const directory = path.join(getCaseIqStateRoot(), "requests", run.id);
  const entries = await readdir(/* turbopackIgnore: true */ directory).catch((error: unknown) => {
    if (missing(error)) return [];
    throw error;
  });
  return Promise.all(entries.map(async (name) => {
    const attempt = path.join(directory, uuid.parse(name));
    if (path.relative(await realpath(/* turbopackIgnore: true */ attempt), attempt) !== "") {
      throw new Error("CaseIQ attempt directory was redirected.");
    }
    const requestFile = path.join(attempt, "request.json");
    const request = parseNativeBridgeRequest(await readOptionalCaseIqBridgeJson(requestFile));
    if (request.mode !== "prompt" || request.runId !== run.id || request.attemptId !== name ||
        request.sessionId !== run.copilotSessionId || path.relative(executionPath, request.workingDirectory) !== "") {
      throw new Error("CaseIQ attempt does not belong to the interrupted Run.");
    }
    return { directory: attempt, request, requestFile };
  }));
}

export async function inspectInterruptedCaseIqRun(run: InterruptedRun) {
  const marker = localRunMarker(run);
  const prelaunchStop = await sealCaseIqRunBeforeLaunch(marker, "interrupted");
  if (prelaunchStop) {
    return { stopped: true, cancelled: prelaunchStop === "cancelled", timedOut: false, beforeLaunch: true, completedRequests: [] };
  }
  const attempts = await readRunAttempts(marker);
  const completedRequests: string[] = [];
  let stopped = attempts.length > 0;
  let cancelled = false;
  let timedOut = false;
  for (const { directory, request, requestFile } of attempts) {
    let wrapper = await readRecordedWrapper(directory, request);
    if (!wrapper && request.trackPromptWrapper && !await attemptReachedInvocation(directory)) {
      const reason = await requestCaseIqBridgeCancellation(directory, request, "shutdown");
      wrapper = await readRecordedWrapper(directory, request);
      // Any late wrapper must record itself before checking the persisted cancellation.
      if (!wrapper && !await attemptReachedInvocation(directory)) {
        cancelled ||= reason === "user";
        timedOut ||= reason === "timeout";
        continue;
      }
    }
    const exit = await readCaseIqAttemptExit(directory, request);
    if (!exit || request.trackPromptWrapper && !wrapper ||
        wrapper && await windowsProcessMatchesStartTime(wrapper.pid, wrapper.startTime)) {
      stopped = false;
      continue;
    }
    timedOut ||= exit.native?.timedOut === true && exit.native.error === null && !exit.launcher.scriptError;
    if (exit.native && exit.native.pid !== null && !exit.launcher.scriptError && exit.native.error === null) completedRequests.push(requestFile);
    if (await hasRetryCancellation(directory, request)) cancelled = true;
    const control = await readOptionalCaseIqBridgeJson(path.join(directory, "cancel.json"));
    if (control !== null) {
      const decision = nativeBridgeCancellationSchema.parse(control);
      assertBridgeCorrelation(decision, request);
      const wrapperStoppedBeforeInvocation = request.trackPromptWrapper === true && exit.native === null &&
        !exit.launcher.scriptError && exit.launcher.launcherExitCode === 130;
      cancelled ||= decision.reason === "user" && (exit.native?.cancelled === true || wrapperStoppedBeforeInvocation);
      timedOut ||= decision.reason === "timeout" && wrapperStoppedBeforeInvocation;
    }
  }
  return { stopped, cancelled: !timedOut && cancelled, timedOut, completedRequests };
}

export async function requestInterruptedCaseIqCancellation(run: InterruptedRun) {
  const marker = localRunMarker(run);
  const prelaunchStop = await sealCaseIqRunBeforeLaunch(marker, "cancelled");
  if (prelaunchStop === "cancelled") return;
  if (prelaunchStop) throw new CaseIqIntegrationError("CaseIQ stopped during preparation. Refresh the Run for its final status.", 409);
  const attempts = await readRunAttempts(marker);
  if (!attempts.length) throw new CaseIqIntegrationError("No matching CaseIQ launch records are available. The Work remains reserved.", 409);
  let userCancellation = false;
  let priorStop = false;
  for (const { directory, request } of attempts) {
    if (!await readCaseIqAttemptExit(directory, request)) {
      const reason = await requestCaseIqBridgeCancellation(directory, request, "user");
      userCancellation ||= reason === "user";
      priorStop ||= reason !== "user";
    }
  }
  if (userCancellation) return;
  if (priorStop) throw caseIqStopAlreadyRequested();
  throw caseIqRunAlreadyFinalizing();
}
