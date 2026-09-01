import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import pidusage from "pidusage";
import { CopilotCompletionTracker } from "@/lib/copilot-completion";

export const RUN_LOG_DIR = path.join(process.cwd(), "data", "runs");

/** Deterministic per-run log file path, stable before the run even starts writing to it. */
export function getRunLogPath(runId: string): string {
  return path.join(RUN_LOG_DIR, `${runId}.log`);
}

export type RunPermissionMode = "default" | "full";
export type RunOutputFormat = "text" | "json";

export interface StartCopilotRunOptions {
  runId: string;
  repoPath: string;
  prompt: string;
  sessionId?: string | null;
  agent?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  contextTier?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: RunPermissionMode;
  outputFormat?: RunOutputFormat;
  timeoutSeconds?: number | null;
  maxIncompleteContinuations?: number;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  executable?: string;
  executableArgs?: string[];
  trackProcessStats?: boolean;
  /** Fired synchronously right after the child process spawns, so callers can persist pid/command early. */
  onSpawn?: (info: { pid: number | null; command: string; model: string | null }) => void;
}

export type CopilotRunEvent =
  | { type: "line"; data: string }
  | { type: "exit"; code: number | null; timedOut: boolean; cancelled: boolean }
  | { type: "error"; message: string };

interface RunProcessStats {
  pid: number;
  cpuTimeMs: number;
  memoryMb: number;
  sampledAt: number;
}

// Pinned to globalThis (like jobQueue in job-queue.ts): in dev mode, route handlers can be
// compiled into separate module instances, which would otherwise give the scheduler's run
// and the SSE route handler two disconnected copies of this state.
const globalForRunner = globalThis as unknown as {
  copilotRunEmitters?: Map<string, EventEmitter>;
  copilotRunProcesses?: Map<string, ChildProcessWithoutNullStreams>;
  copilotCancelledRunIds?: Set<string>;
  copilotRunStats?: Map<string, RunProcessStats>;
};

// One emitter per in-flight run; SSE endpoints subscribe to stream live output.
const runEmitters = globalForRunner.copilotRunEmitters ?? new Map<string, EventEmitter>();
// In-flight child processes, keyed by runId, so a run can be cancelled on demand.
const runProcesses =
  globalForRunner.copilotRunProcesses ?? new Map<string, ChildProcessWithoutNullStreams>();
// Runs that were explicitly cancelled, so their `close` handler reports it accurately.
const cancelledRunIds = globalForRunner.copilotCancelledRunIds ?? new Set<string>();
// Latest pidusage sample per in-flight run, for the "process info" panel / live polling endpoint.
const runStats = globalForRunner.copilotRunStats ?? new Map<string, RunProcessStats>();

globalForRunner.copilotRunEmitters = runEmitters;
globalForRunner.copilotRunProcesses = runProcesses;
globalForRunner.copilotCancelledRunIds = cancelledRunIds;
globalForRunner.copilotRunStats = runStats;

export function getRunEmitter(runId: string): EventEmitter | undefined {
  return runEmitters.get(runId);
}

export function createRunEmitter(runId: string): EventEmitter {
  const emitter = new EventEmitter();
  runEmitters.set(runId, emitter);
  return emitter;
}

export function releaseRunEmitter(runId: string): void {
  runEmitters.delete(runId);
}

/** Latest known CPU/memory sample for an in-flight run, if any (undefined once the run has finished). */
export function getRunProcessStats(runId: string): RunProcessStats | undefined {
  return runStats.get(runId);
}

/**
 * Attempts to terminate an in-flight run's child process (SIGTERM, then SIGKILL after a
 * grace period). Returns false if no in-memory process is tracked for this runId (e.g. the
 * run already finished, or the server restarted since it started).
 */
export function cancelRun(runId: string): boolean {
  cancelledRunIds.add(runId);
  const child = runProcesses.get(runId);
  if (!child) return false;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5000);
  return true;
}

export function buildCopilotEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "PSModulePath",
    "NODE_PATH",
    "NVM_HOME",
    "NVM_SYMLINK",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "GH_HOST",
    "COPILOT_GH_HOST",
    "COPILOT_HOME",
    "COPILOT_CACHE_HOME",
    "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
    "COPILOT_SKILLS_DIRS",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);
  const environment: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV ?? "production" };
  for (const [name, value] of Object.entries(source)) {
    if (allowedNames.has(name) && value !== undefined) environment[name] = value;
  }
  return environment;
}

export function extractFinalCopilotOutput(output: string): string | null {
  let finalOutput: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        agentId?: unknown;
        data?: { content?: unknown };
      };
      if (
        event.type === "assistant.message" &&
        typeof event.agentId !== "string" &&
        typeof event.data?.content === "string" &&
        event.data.content.trim()
      ) {
        finalOutput = event.data.content;
      }
    } catch {
      // Text output and partial JSON lines are handled by the fallback below.
    }
  }
  return finalOutput ?? (output.trim() || null);
}

const INCOMPLETE_SESSION_PROMPT = `Continue and complete the original task. The previous non-interactive process exited before completion was confirmed, and unfinished background sub-agents may have been cancelled. Inspect the work already produced, restart any unfinished analysis as needed, wait for every background sub-agent and tool to finish, then produce the final requested deliverables and a root-level final answer. Do not return a progress-only message.`;

function buildArgs(
  opts: StartCopilotRunOptions,
  model: string | null,
  resumeSession: boolean
): string[] {
  const args: string[] = [
    "-p",
    resumeSession ? INCOMPLETE_SESSION_PROMPT : opts.prompt,
    "--output-format",
    opts.outputFormat ?? "text",
  ];

  args.push(opts.permissionMode === "full" ? "--allow-all" : "--allow-all-tools");

  if (opts.sessionId) {
    args.push(resumeSession ? `--resume=${opts.sessionId}` : "--session-id");
    if (!resumeSession) args.push(opts.sessionId);
  }
  if (opts.agent) args.push("--agent", opts.agent);
  if (model) args.push("--model", model);
  if (opts.contextTier) args.push("--context", opts.contextTier);
  if (opts.reasoningEffort) args.push("--effort", opts.reasoningEffort);

  // Auto-redact common credential env vars from captured output.
  args.push("--secret-env-vars", "GH_TOKEN,GITHUB_TOKEN");

  return args;
}

export function isModelUnavailableError(output: string): boolean {
  return /^Error:\s+Model ".+" from --model flag is not available\.?\s*$/im.test(output);
}

/**
 * Spawns `copilot -p <prompt>` in the target repo directory, streams output to a
 * per-run log file and to any live SSE subscribers, with an optional hard timeout.
 */
export async function startCopilotRun(opts: StartCopilotRunOptions): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  logPath: string;
  pid: number | null;
  command: string;
  model: string | null;
  cpuTimeMs: number | null;
  peakMemoryMb: number | null;
  finalOutput: string | null;
  incomplete: boolean;
  incompleteReason: string | null;
  continuationCount: number;
}> {
  await mkdir(RUN_LOG_DIR, { recursive: true });
  const logPath = getRunLogPath(opts.runId);
  if (opts.stdoutLogPath) await mkdir(path.dirname(opts.stdoutLogPath), { recursive: true });
  if (opts.stderrLogPath) await mkdir(path.dirname(opts.stderrLogPath), { recursive: true });
  if (cancelledRunIds.delete(opts.runId)) {
    return {
      exitCode: null,
      timedOut: false,
      cancelled: true,
      logPath,
      pid: null,
      command: "copilot <cancelled-before-start>",
      model: opts.model ?? null,
      cpuTimeMs: null,
      peakMemoryMb: null,
      finalOutput: null,
      incomplete: false,
      incompleteReason: null,
      continuationCount: 0,
    };
  }

  const emitter = createRunEmitter(opts.runId);

  const timeoutMs = resolveCopilotTimeoutMs(opts.timeoutSeconds);
  const timeoutDeadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  const requestedModel = opts.model ?? null;
  const fallbackModel =
    opts.fallbackModel && opts.fallbackModel !== requestedModel ? opts.fallbackModel : null;
  let fallbackAttempted = false;
  const maxIncompleteContinuations = opts.maxIncompleteContinuations ?? 0;

  return new Promise((resolve) => {
    const startAttempt = (
      model: string | null,
      continuationCount = 0,
      resumeSession = false
    ) => {
      const args = buildArgs(opts, model, resumeSession);
      const testExecutable = process.env.NODE_ENV === "test" ? opts.executable : undefined;
      const testExecutableArgs = process.env.NODE_ENV === "test" ? opts.executableArgs : undefined;
      const processArgs = [...(testExecutableArgs ?? []), ...args];
      const commandArgs = args.map((arg, index) => (index > 0 && args[index - 1] === "-p" ? "<prompt>" : arg));
      const command = `copilot ${commandArgs.join(" ")}`;
      let timedOut = false;
      let settled = false;
      let recentOutput = "";
      let statsTimer: NodeJS.Timeout | undefined;
      let pendingWrites = Promise.resolve();
      const completionTracker = new CopilotCompletionTracker();

      const child: ChildProcessWithoutNullStreams = spawn(
        /* turbopackIgnore: true */ testExecutable ?? "copilot",
        processArgs,
        {
        cwd: opts.repoPath,
        env: buildCopilotEnvironment(),
        windowsHide: true,
        }
      );
      runProcesses.set(opts.runId, child);
      opts.onSpawn?.({ pid: child.pid ?? null, command, model });

      if (child.pid && opts.trackProcessStats !== false) {
        const pid = child.pid;
        const sample = async () => {
          try {
            const stat = await pidusage(pid);
            runStats.set(opts.runId, {
              pid,
              cpuTimeMs: Math.round(stat.ctime),
              memoryMb: stat.memory / (1024 * 1024),
              sampledAt: Date.now(),
            });
          } catch {
            // Process may have exited between the tick and the sample; ignore.
          }
        };
        void sample();
        statsTimer = setInterval(sample, 3000);
      }

      const remainingTimeoutMs =
        timeoutDeadline === null ? null : Math.max(0, timeoutDeadline - Date.now());
      const timer =
        remainingTimeoutMs === null
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
              setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              }, 5000);
            }, remainingTimeoutMs);

      const handleChunk = (
        chunk: Buffer,
        streamLogPath?: string,
        trackCompletion = false
      ) => {
        const text = chunk.toString("utf8");
        if (trackCompletion) completionTracker.push(text);
        recentOutput = (recentOutput + text).slice(-16_384);
        pendingWrites = pendingWrites.then(async () => {
          await appendFile(logPath, text).catch(() => {});
          if (streamLogPath) await appendFile(streamLogPath, text).catch(() => {});
        });
        for (const line of text.split("\n")) {
          if (line.length === 0) continue;
          emitter.emit("event", { type: "line", data: line } satisfies CopilotRunEvent);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => handleChunk(chunk, opts.stdoutLogPath, true));
      child.stderr.on("data", (chunk: Buffer) => handleChunk(chunk, opts.stderrLogPath));

      const finish = async (
        exitCode: number | null,
        cancelled: boolean,
        errorMessage?: string,
        incompleteReason: string | null = null
      ) => {
        await pendingWrites;
        const finalStats = runStats.get(opts.runId);
        runProcesses.delete(opts.runId);
        runStats.delete(opts.runId);
        cancelledRunIds.delete(opts.runId);
        if (errorMessage) {
          emitter.emit("event", { type: "error", message: errorMessage } satisfies CopilotRunEvent);
        } else {
          emitter.emit("event", {
            type: "exit",
            code: exitCode,
            timedOut,
            cancelled,
          } satisfies CopilotRunEvent);
        }
        releaseRunEmitter(opts.runId);
        resolve({
          exitCode,
          timedOut,
          cancelled,
          logPath,
          pid: child.pid ?? null,
          command,
          model,
          cpuTimeMs: finalStats?.cpuTimeMs ?? null,
          peakMemoryMb: finalStats?.memoryMb ?? null,
          finalOutput: opts.outputFormat === "json" ? null : extractFinalCopilotOutput(recentOutput),
          incomplete: incompleteReason !== null,
          incompleteReason,
          continuationCount,
        });
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(statsTimer);
        void finish(null, false, err.message);
      });

      child.on("close", async (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(statsTimer);
        const cancelled = cancelledRunIds.has(opts.runId);
        const completion = completionTracker.finish();
        const shouldFallback =
          code !== 0 &&
          !timedOut &&
          !cancelled &&
          !fallbackAttempted &&
          fallbackModel &&
          isModelUnavailableError(recentOutput);

        if (shouldFallback) {
          await pendingWrites;
          runProcesses.delete(opts.runId);
          runStats.delete(opts.runId);
          fallbackAttempted = true;
          const notice = `[CodeBoard] Model "${model}" is unavailable; retrying with fallback "${fallbackModel}".`;
          emitter.emit("event", { type: "line", data: notice } satisfies CopilotRunEvent);
          await appendFile(logPath, `${notice}\n`).catch(() => {});
          startAttempt(fallbackModel, continuationCount, resumeSession);
          return;
        }

        const completionEvidenceMissing =
          !completion.taskComplete && completion.rootFinalOutput === null;
        const incompleteRun =
          code === 0 &&
          !timedOut &&
          !cancelled &&
          (opts.outputFormat ?? "text") === "json" &&
          (completion.openSubagents.length > 0 ||
            completion.openTools.length > 0 ||
            completionEvidenceMissing);
        if (
          incompleteRun &&
          opts.sessionId &&
          continuationCount < maxIncompleteContinuations
        ) {
          await pendingWrites;
          runProcesses.delete(opts.runId);
          runStats.delete(opts.runId);
          const issue = completion.openSubagents.length
            ? `${completion.openSubagents.length} background sub-agent(s) were still active (${completion.openSubagents.map((agent) => agent.name).join(", ")})`
            : completion.openTools.length
              ? `${completion.openTools.length} tool call(s) were still active (${completion.openTools.map((tool) => tool.name).join(", ")})`
            : "no root-level final response was emitted";
          const notice = `[Work Board] Copilot exited before completion: ${issue}. Resuming the same session (${continuationCount + 1}/${maxIncompleteContinuations}).`;
          emitter.emit("event", { type: "line", data: notice } satisfies CopilotRunEvent);
          await appendFile(logPath, `${notice}\n`).catch(() => {});
          if (opts.stdoutLogPath) {
            await appendFile(opts.stdoutLogPath, `${notice}\n`).catch(() => {});
          }
          startAttempt(model, continuationCount + 1, true);
          return;
        }

        const incompleteReason = incompleteRun
          ? completion.openSubagents.length
            ? `Copilot exited with ${completion.openSubagents.length} unfinished background sub-agent(s) after ${continuationCount} automatic continuation attempt(s).`
            : completion.openTools.length
              ? `Copilot exited with ${completion.openTools.length} unfinished tool call(s) after ${continuationCount} automatic continuation attempt(s).`
            : `Copilot exited without a root-level final response after ${continuationCount} automatic continuation attempt(s).`
          : null;

        await finish(code, cancelled, undefined, incompleteReason);
      });
    };

    startAttempt(requestedModel);
  });
}

export function resolveCopilotTimeoutMs(
  timeoutSeconds: number | null | undefined
): number | null {
  return timeoutSeconds === null ? null : (timeoutSeconds ?? 1800) * 1000;
}
