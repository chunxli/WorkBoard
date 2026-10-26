import { appendFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  approveAll,
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type ResumeSessionConfig,
  type SessionConfig,
} from "@github/copilot-sdk";
import {
  buildCopilotEnvironment,
  createRunEmitter,
  extractFinalCopilotOutput,
  getRunLogPath,
  isModelUnavailableError,
  releaseRunEmitter,
  type RunOutputFormat,
  type RunPermissionMode,
  type CopilotRunEvent,
} from "@/lib/copilot-runner";
import {
  getManagedSessionController,
  ManagedSessionController,
  registerManagedSessionController,
  unregisterManagedSessionController,
} from "@/lib/managed-session-controller";
import { readCopilotSessionInsights } from "@/lib/copilot-session-insights";

interface ManagedRunOptions {
  runId: string;
  sessionId: string;
  workPath: string;
  prompt: string;
  attachments?: { type: "file"; path: string; displayName?: string }[];
  resumeSession?: boolean;
  agent?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  contextTier?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: RunPermissionMode;
  outputFormat?: RunOutputFormat;
  timeoutSeconds?: number | null;
  stdoutLogPath: string;
  stderrLogPath: string;
  onSpawn?: (info: { pid: null; command: string; model: string | null }) => void;
  runtime: "sdk" | "cli";
}

interface ManagedRunResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  logPath: string;
  pid: null;
  command: string;
  model: string | null;
  cpuTimeMs: null;
  peakMemoryMb: null;
  finalOutput: string | null;
  incomplete: boolean;
  incompleteReason: string | null;
  continuationCount: number;
}

type SdkSessionClient = Pick<CopilotClient, "createSession" | "resumeSession">;

const INCOMPLETE_SESSION_PROMPT =
  "Continue and complete the original task. The previous turn ended before completion was confirmed, and unfinished background sub-agents may have been cancelled. Inspect the work already produced, restart unfinished analysis as needed, wait for every background sub-agent and tool to finish, then produce the requested deliverables and a root-level final answer.";
const MAX_INCOMPLETE_CONTINUATIONS = 3;

const globalForSdk = globalThis as unknown as {
  copilotSdkSessions?: Map<string, CopilotSession>;
  copilotSdkCancelledRuns?: Set<string>;
  copilotSdkManagedRuns?: Set<string>;
};
const activeSessions = globalForSdk.copilotSdkSessions ?? new Map<string, CopilotSession>();
const cancelledRuns = globalForSdk.copilotSdkCancelledRuns ?? new Set<string>();
const managedRuns = globalForSdk.copilotSdkManagedRuns ?? new Set<string>();
globalForSdk.copilotSdkSessions = activeSessions;
globalForSdk.copilotSdkCancelledRuns = cancelledRuns;
globalForSdk.copilotSdkManagedRuns = managedRuns;

export function resolveCopilotCliExecutable(): string {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = execFileSync(resolver, ["copilot"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const candidates = result.split(/\r?\n/).map((candidate) => candidate.trim()).filter(Boolean);
  const executable = process.platform === "win32"
    ? candidates.find((candidate) => /\.(exe|com|js)$/i.test(candidate)) ??
      candidates.find((candidate) => !/\.(cmd|bat|ps1|lnk)$/i.test(candidate))
    : candidates[0];
  if (!executable) {
    throw new Error("Copilot CLI has no directly spawnable executable on PATH; install the CLI executable rather than a shell wrapper.");
  }
  return executable;
}

export function getCopilotCliPermissionArgs(permissionMode: RunPermissionMode = "default"): string[] {
  return [permissionMode === "full" ? "--allow-all" : "--allow-all-tools"];
}

export function createManagedRuntimeConnection(
  runtime: ManagedRunOptions["runtime"],
  permissionMode: RunPermissionMode = "default",
  executable?: string
) {
  return runtime === "cli"
    ? RuntimeConnection.forStdio({
        path: executable ?? resolveCopilotCliExecutable(),
        args: getCopilotCliPermissionArgs(permissionMode),
      })
    : undefined;
}

export function buildManagedSessionConfig(
  runtime: ManagedRunOptions["runtime"],
  options: Pick<ManagedRunOptions, "workPath" | "model" | "agent" | "contextTier" | "reasoningEffort">
): ResumeSessionConfig {
  return {
    workingDirectory: options.workPath,
    model: options.model ?? undefined,
    ...(runtime === "cli" ? { agent: options.agent ?? undefined, enableConfigDiscovery: true } : {}),
    contextTier: options.contextTier === "long_context" ? "long_context" : "default",
    reasoningEffort: options.reasoningEffort as SessionConfig["reasoningEffort"],
    streaming: true,
    ...(runtime === "sdk" ? { onPermissionRequest: approveAll } : {}),
  } satisfies ResumeSessionConfig;
}

export function openCopilotSdkSession(
  client: SdkSessionClient,
  sessionId: string,
  config: Omit<SessionConfig, "sessionId">,
  resumeSession: boolean
): Promise<CopilotSession> {
  return resumeSession
    ? client.resumeSession(sessionId, {
        ...config,
        continuePendingWork: false,
      } satisfies ResumeSessionConfig)
    : client.createSession({ ...config, sessionId });
}

export function cancelSdkRun(runId: string): boolean {
  const session = activeSessions.get(runId);
  const controller = getController(runId);
  if (!managedRuns.has(runId) && !session && !controller) return false;
  if (managedRuns.has(runId)) cancelledRuns.add(runId);
  if (controller) void controller.abort().catch(() => {});
  else if (session) void session.abort().catch(() => {});
  return true;
}

function getController(runId: string): ManagedSessionController | null {
  return getManagedSessionController(runId);
}

export function startCopilotCliControlledRun(
  options: Omit<ManagedRunOptions, "runtime">
): Promise<ManagedRunResult> {
  return startManagedRun({ ...options, runtime: "cli" });
}

export function startCopilotSdkRun(
  options: Omit<ManagedRunOptions, "runtime" | "fallbackModel" | "permissionMode" | "outputFormat">
): Promise<ManagedRunResult> {
  return startManagedRun({ ...options, runtime: "sdk" });
}

async function startManagedRun(options: ManagedRunOptions): Promise<ManagedRunResult> {
  managedRuns.add(options.runId);
  const logPath = getRunLogPath(options.runId);
  try {
    await Promise.all([
      mkdir(path.dirname(logPath), { recursive: true }),
      mkdir(path.dirname(options.stdoutLogPath), { recursive: true }),
      mkdir(path.dirname(options.stderrLogPath), { recursive: true }),
    ]);
  } catch (error) {
    managedRuns.delete(options.runId);
    throw error;
  }

  const command = options.runtime === "cli"
    ? `copilot --headless --stdio --no-auto-update ${getCopilotCliPermissionArgs(options.permissionMode).join(" ")} (controlled via Copilot SDK RPC)`
    : `copilot-sdk session ${options.sessionId}`;
  const emptyResult = (
    overrides: Partial<ManagedRunResult> = {}
  ): ManagedRunResult => ({
    exitCode: null,
    timedOut: false,
    cancelled: false,
    logPath,
    pid: null,
    command,
    model: options.model ?? null,
    cpuTimeMs: null,
    peakMemoryMb: null,
    finalOutput: null,
    incomplete: false,
    incompleteReason: null,
    continuationCount: 0,
    ...overrides,
  });

  if (cancelledRuns.delete(options.runId)) {
    managedRuns.delete(options.runId);
    return emptyResult({ cancelled: true });
  }

  const emitter = createRunEmitter(options.runId);
  const client = new CopilotClient({
    ...(options.runtime === "cli"
      ? { connection: createManagedRuntimeConnection(options.runtime, options.permissionMode) }
      : {}),
    mode: "copilot-cli",
    workingDirectory: options.workPath,
    env: buildCopilotEnvironment(),
    logLevel: "warning",
  });
  let session: CopilotSession | null = null;
  let controller: ManagedSessionController | null = null;
  let unsubscribe: (() => void) | null = null;
  let timedOut = false;
  let lastAssistantOutput: string | null = null;
  let currentModel = options.model ?? null;
  let fallbackAttempted = false;
  let continuationCount = 0;
  let sessionEventCursor = 0;
  let pendingWrites = Promise.resolve();
  let completedResult: ManagedRunResult | null = null;

  const appendEvent = (event: unknown) => {
    const line = JSON.stringify(event);
    pendingWrites = pendingWrites.then(async () => {
      await appendFile(logPath, `${line}\n`).catch(() => {});
      await appendFile(options.stdoutLogPath, `${line}\n`).catch(() => {});
    });
    emitter.emit("event", { type: "line", data: line } satisfies CopilotRunEvent);
  };

  const makeSessionConfig = (model: string | null) =>
    buildManagedSessionConfig(options.runtime, { ...options, model });

  const listenToSession = (activeSession: CopilotSession): ManagedSessionController => {
    const currentController = new ManagedSessionController(activeSession);
    registerManagedSessionController(options.runId, currentController);
    unsubscribe = activeSession.on((event) => {
      appendEvent(event);
      if (event.type === "assistant.message" && event.agentId == null) {
        lastAssistantOutput = event.data.content;
      } else if (event.type === "session.idle") {
        currentController.observeIdle();
      } else if (event.type === "session.error") {
        currentController.observeError(new Error(event.data.message));
      }
    });
    return currentController;
  };

  const connectSession = async (resume: boolean, model: string | null) => {
    session = await openCopilotSdkSession(
      client,
      options.sessionId,
      makeSessionConfig(model),
      resume
    );
    activeSessions.set(options.runId, session);
    controller = listenToSession(session);
    options.onSpawn?.({ pid: null, command, model });
  };

  const closeSessionBinding = async () => {
    unsubscribe?.();
    unsubscribe = null;
    const activeController = getManagedSessionController(options.runId);
    if (activeController) {
      activeController.stopAdmission();
      unregisterManagedSessionController(options.runId, activeController);
    }
    controller = null;
    try {
      await session?.disconnect();
    } finally {
      session = null;
      activeSessions.delete(options.runId);
    }
  };

  const timeoutMs = options.timeoutSeconds === null
    ? null
    : (options.timeoutSeconds ?? 1800) * 1000;
  let timeout: NodeJS.Timeout | undefined;

  try {
    await client.start();
    options.onSpawn?.({ pid: null, command, model: currentModel });
    await connectSession(options.resumeSession === true, currentModel);
    const baseline = await readCopilotSessionInsights(options.sessionId).catch(() => null);
    sessionEventCursor = baseline?.eventCount ?? 0;
    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        const activeController = getManagedSessionController(options.runId);
        void activeController?.abort().catch((error) => {
          activeController.observeError(error instanceof Error ? error : new Error(String(error)));
        });
      }, timeoutMs);
    }

    const sendAndWait = async (prompt: string, attachments?: ManagedRunOptions["attachments"]) => {
      await session!.send({ prompt, ...(attachments?.length ? { attachments } : {}) });
      await controller!.waitForIdle();
    };

    try {
      if (cancelledRuns.has(options.runId)) {
        await controller!.abort();
      } else {
        await sendAndWait(options.prompt || "Please review the attached files.", options.attachments);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackModel =
        options.runtime === "cli" &&
        !fallbackAttempted &&
        options.fallbackModel &&
        options.fallbackModel !== currentModel &&
        isModelUnavailableError(message)
          ? options.fallbackModel
          : null;
      if (!fallbackModel) throw error;
      fallbackAttempted = true;
      currentModel = fallbackModel;
      await closeSessionBinding();
      const notice = `[CodeBoard] Model "${options.model}" is unavailable; retrying with fallback "${fallbackModel}".`;
      appendEvent({ type: "workboard.notice", data: { message: notice } });
      await connectSession(true, fallbackModel);
      await sendAndWait(options.prompt || "Please review the attached files.", options.attachments);
    }

    while (!timedOut && !cancelledRuns.has(options.runId)) {
      await pendingWrites;
      const insights = await readCopilotSessionInsights(options.sessionId, sessionEventCursor).catch(() => null);
      const completion = insights?.completion ?? null;
      const missing =
        !completion?.taskComplete &&
        completion?.rootFinalOutput === null;
      const incomplete =
        options.runtime === "cli" &&
        (!insights ||
          Boolean(
            missing ||
            completion?.openSubagents.length ||
            completion?.openTools.length ||
            completion?.cancelledSubagents.length ||
            completion?.failedSubagents.length ||
            completion?.aborted
          ));
      if (incomplete && continuationCount < MAX_INCOMPLETE_CONTINUATIONS) {
        sessionEventCursor = insights?.eventCount ?? sessionEventCursor;
        continuationCount += 1;
        const reason = completion?.openSubagents.length
          ? `${completion.openSubagents.length} background sub-agent(s) remained active`
          : completion?.openTools.length
            ? `${completion.openTools.length} tool call(s) remained active`
            : "a root-level final response was not confirmed";
        const notice = `[Work Board] Copilot ended before completion was confirmed because ${reason}; continuing the same session (${continuationCount}/${MAX_INCOMPLETE_CONTINUATIONS}).`;
        appendEvent({ type: "workboard.notice", data: { message: notice } });
        await appendFile(options.stdoutLogPath, `${notice}\n`).catch(() => {});
        getManagedSessionController(options.runId)?.continueAfterIdle();
        await sendAndWait(INCOMPLETE_SESSION_PROMPT);
        continue;
      }

      let incompleteReason: string | null = null;
      if (incomplete) {
        incompleteReason = !insights
          ? `Copilot session completion evidence remained unavailable after ${continuationCount} automatic continuation attempt(s).`
          : completion?.openSubagents.length
            ? `Copilot exited with ${completion.openSubagents.length} unfinished background sub-agent(s) after ${continuationCount} automatic continuation attempt(s).`
            : completion?.openTools.length
              ? `Copilot exited with ${completion.openTools.length} unfinished tool call(s) after ${continuationCount} automatic continuation attempt(s).`
              : `Copilot exited without a root-level final response after ${continuationCount} automatic continuation attempt(s).`;
      }
      getManagedSessionController(options.runId)?.finish();
      const cancelled = cancelledRuns.has(options.runId);
      const exitCode = cancelled || timedOut || incomplete ? null : 0;
      const finalOutput = (options.outputFormat ?? "text") === "json"
        ? null
        : completion?.rootFinalOutput ?? lastAssistantOutput;
      const result = emptyResult({
        exitCode,
        timedOut,
        cancelled,
        model: currentModel,
        finalOutput,
        incomplete,
        incompleteReason,
        continuationCount,
      });
      completedResult = result;
      return result;
    }

    getManagedSessionController(options.runId)?.finish();
    const cancelled = cancelledRuns.has(options.runId);
    const result = emptyResult({ timedOut, cancelled, model: currentModel });
    completedResult = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pendingWrites;
    await appendFile(options.stderrLogPath, `${message}\n`).catch(() => {});
    const cancelled = cancelledRuns.has(options.runId);
    if (cancelled || timedOut) {
      completedResult = emptyResult({ timedOut, cancelled, model: currentModel });
      return completedResult;
    }
    emitter.emit("event", { type: "error", message } satisfies CopilotRunEvent);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    getManagedSessionController(options.runId)?.stopAdmission();
    await pendingWrites;
    const shutdownErrors: unknown[] = [];
    await closeSessionBinding().catch((error: unknown) => { shutdownErrors.push(error); });
    cancelledRuns.delete(options.runId);
    managedRuns.delete(options.runId);
    const stopErrors = await client.stop().catch((errors: unknown) => [errors]);
    if (Array.isArray(stopErrors)) shutdownErrors.push(...stopErrors);
    activeSessions.delete(options.runId);
    if (shutdownErrors.length > 0) {
      await appendFile(
        options.stderrLogPath,
        `Copilot runtime shutdown reported ${shutdownErrors.length} error(s).\n`
      ).catch(() => {});
      emitter.emit("event", {
        type: "error", message: "Copilot runtime shutdown could not be confirmed.",
      } satisfies CopilotRunEvent);
      releaseRunEmitter(options.runId);
      throw new AggregateError(shutdownErrors, "Copilot runtime shutdown could not be confirmed.");
    }
    if (completedResult) {
      emitter.emit("event", {
        type: "exit",
        code: completedResult.exitCode,
        timedOut: completedResult.timedOut,
        cancelled: completedResult.cancelled,
      } satisfies CopilotRunEvent);
    }
    releaseRunEmitter(options.runId);
  }
}

export function resolveCliRunFinalOutput(
  outputFormat: RunOutputFormat,
  rawOutput: string
): string | null {
  return outputFormat === "json" ? null : extractFinalCopilotOutput(rawOutput);
}
