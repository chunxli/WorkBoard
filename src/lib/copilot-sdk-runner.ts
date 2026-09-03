import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  approveAll,
  CopilotClient,
  type ResumeSessionConfig,
  type CopilotSession,
  type SessionConfig,
} from "@github/copilot-sdk";
import {
  buildCopilotEnvironment,
  createRunEmitter,
  getRunLogPath,
  releaseRunEmitter,
  type CopilotRunEvent,
} from "@/lib/copilot-runner";

interface SdkRunOptions {
  runId: string;
  sessionId: string;
  workPath: string;
  prompt: string;
  resumeSession?: boolean;
  model?: string | null;
  contextTier?: string | null;
  reasoningEffort?: string | null;
  timeoutSeconds?: number | null;
  stdoutLogPath: string;
  stderrLogPath: string;
  onSpawn?: (info: { pid: null; command: string; model: string | null }) => void;
}

type SdkSessionClient = Pick<CopilotClient, "createSession" | "resumeSession">;

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

const globalForSdk = globalThis as unknown as {
  copilotSdkSessions?: Map<string, CopilotSession>;
  copilotSdkCancelledRuns?: Set<string>;
  copilotSdkCancelWaiters?: Map<string, () => void>;
};

const activeSessions = globalForSdk.copilotSdkSessions ?? new Map<string, CopilotSession>();
const cancelledRuns = globalForSdk.copilotSdkCancelledRuns ?? new Set<string>();
const cancelWaiters = globalForSdk.copilotSdkCancelWaiters ?? new Map<string, () => void>();

globalForSdk.copilotSdkSessions = activeSessions;
globalForSdk.copilotSdkCancelledRuns = cancelledRuns;
globalForSdk.copilotSdkCancelWaiters = cancelWaiters;

export function cancelSdkRun(runId: string): boolean {
  cancelledRuns.add(runId);
  cancelWaiters.get(runId)?.();
  const session = activeSessions.get(runId);
  if (!session) return false;
  void session.abort().catch(() => {});
  return true;
}

export async function startCopilotSdkRun(options: SdkRunOptions): Promise<{
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
}> {
  const logPath = getRunLogPath(options.runId);
  await Promise.all([
    mkdir(path.dirname(logPath), { recursive: true }),
    mkdir(path.dirname(options.stdoutLogPath), { recursive: true }),
    mkdir(path.dirname(options.stderrLogPath), { recursive: true }),
  ]);

  if (cancelledRuns.delete(options.runId)) {
    return {
      exitCode: null,
      timedOut: false,
      cancelled: true,
      logPath,
      pid: null,
      command: `copilot-sdk session ${options.sessionId}`,
      model: options.model ?? null,
      cpuTimeMs: null,
      peakMemoryMb: null,
      finalOutput: null,
    };
  }

  const emitter = createRunEmitter(options.runId);
  const client = new CopilotClient({
    mode: "copilot-cli",
    workingDirectory: options.workPath,
    env: buildCopilotEnvironment(),
    logLevel: "warning",
  });
  let session: CopilotSession | null = null;
  let timedOut = false;
  let pendingWrites = Promise.resolve();
  let lastAssistantOutput: string | null = null;
  const command = `copilot-sdk session ${options.sessionId}`;
  options.onSpawn?.({ pid: null, command, model: options.model ?? null });

  try {
    await client.start();
    const sessionConfig = {
      workingDirectory: options.workPath,
      model: options.model ?? undefined,
      contextTier: options.contextTier === "long_context" ? "long_context" : "default",
      reasoningEffort: options.reasoningEffort as SessionConfig["reasoningEffort"],
      streaming: true,
      onPermissionRequest: approveAll,
    } satisfies ResumeSessionConfig;
    session = await openCopilotSdkSession(
      client,
      options.sessionId,
      sessionConfig,
      options.resumeSession === true
    );
    activeSessions.set(options.runId, session);

    const timeoutMs =
      options.timeoutSeconds === null
        ? null
        : (options.timeoutSeconds ?? 1800) * 1000;
    let settleCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    let completionSettled = false;
    const completion = new Promise<void>((resolve, reject) => {
      settleCompletion = () => {
        if (completionSettled) return;
        completionSettled = true;
        resolve();
      };
      rejectCompletion = (error) => {
        if (completionSettled) return;
        completionSettled = true;
        reject(error);
      };
    });
    const unsubscribe = session.on((event) => {
      const line = JSON.stringify(event);
      pendingWrites = pendingWrites.then(async () => {
        await appendFile(logPath, `${line}\n`).catch(() => {});
        await appendFile(options.stdoutLogPath, `${line}\n`).catch(() => {});
      });
      emitter.emit("event", { type: "line", data: line } satisfies CopilotRunEvent);
      if (event.type === "assistant.message") {
        lastAssistantOutput = event.data.content;
      } else if (event.type === "session.idle") {
        settleCompletion();
      } else if (event.type === "session.error") {
        rejectCompletion(new Error(event.data.message));
      }
    });
    const settleCancelled = () => settleCompletion();
    cancelWaiters.set(options.runId, settleCancelled);
    const timeout = timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          settleCompletion();
          void session?.abort().catch(() => {});
        }, timeoutMs);

    try {
      if (cancelledRuns.has(options.runId)) {
        settleCompletion();
      } else {
        await session.send({ prompt: options.prompt });
      }
      await completion;
    } finally {
      if (timeout) clearTimeout(timeout);
      cancelWaiters.delete(options.runId);
      unsubscribe();
    }
    await pendingWrites;

    const cancelled = cancelledRuns.has(options.runId);
    emitter.emit("event", {
      type: "exit",
      code: timedOut || cancelled ? null : 0,
      timedOut,
      cancelled,
    } satisfies CopilotRunEvent);
    return {
      exitCode: timedOut || cancelled ? null : 0,
      timedOut,
      cancelled,
      logPath,
      pid: null,
      command,
      model: options.model ?? null,
      cpuTimeMs: null,
      peakMemoryMb: null,
      finalOutput: lastAssistantOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = cancelledRuns.has(options.runId);
    await pendingWrites;
    await appendFile(options.stderrLogPath, `${message}\n`).catch(() => {});
    if (cancelled || timedOut) {
      emitter.emit("event", {
        type: "exit",
        code: null,
        timedOut,
        cancelled,
      } satisfies CopilotRunEvent);
      return {
        exitCode: null,
        timedOut,
        cancelled,
        logPath,
        pid: null,
        command,
        model: options.model ?? null,
        cpuTimeMs: null,
        peakMemoryMb: null,
        finalOutput: null,
      };
    }
    emitter.emit("event", { type: "error", message } satisfies CopilotRunEvent);
    throw error;
  } finally {
    await pendingWrites;
    activeSessions.delete(options.runId);
    cancelWaiters.delete(options.runId);
    cancelledRuns.delete(options.runId);
    await session?.disconnect().catch(() => {});
    await client.stop().catch(() => []);
    releaseRunEmitter(options.runId);
  }
}