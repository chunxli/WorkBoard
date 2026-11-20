import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { z } from "zod";
import { acceptCaseIqPreparation, finalizeCaseIqSessionHome, prepareCaseIqPrompt } from "@/lib/caseiq-integration";
import { workspaceInstructionEnvironment } from "@/lib/work-pair-directories";
import type { CaseIqStartupPhase } from "@/lib/caseiq-startup";
import { clearCaseIqStartup, reportCaseIqStartup } from "@/lib/caseiq-startup-state";
import { CopilotCompletionTracker, type CopilotCompletionSummary } from "@/lib/copilot-completion";
import { stopCopilotProcess } from "@/lib/copilot-process";
import {
  buildCopilotEnvironment, createRunEmitter, getRunLogPath, INCOMPLETE_SESSION_PROMPT,
  isModelUnavailableError, registerNativeRunControl, releaseRunEmitter, resolveCopilotTimeoutMs,
  type CopilotRunEvent, type StartCopilotRunOptions, startCopilotRun,
} from "@/lib/copilot-runner";
import { analyzeCopilotSessionEvents, readCopilotSessionInsights, subtractCopilotTokenUsage } from "@/lib/copilot-session-insights";
import { getCaseIqStateRoot } from "@/lib/native-runtime-paths";
import { readNativeSessionBindingSync } from "@/lib/native-session-bindings";
import type { CaseIqRunVersion } from "@/lib/run-artifacts";
import {
  MAX_BRIDGE_FILE_BYTES, assertBridgeCorrelation, bridgeCorrelation, launcherResultSchema,
  nativeBridgeCancellationSchema, nativeBridgeFrameSchema, parseNativeBridgeRequest,
} from "../../scripts/native-bridge-protocol.mjs";

type BridgeRequest = ReturnType<typeof parseNativeBridgeRequest>;
type BridgeFrame = z.infer<typeof nativeBridgeFrameSchema>;
type NativeResult = Extract<BridgeFrame, { kind: "native-result" }>;
type RunResult = Awaited<ReturnType<typeof startCopilotRun>>;

interface CaseIqRunOptions extends Omit<StartCopilotRunOptions, "executable" | "executableArgs" | "permissionMode"> {
  userId: string;
  workId: string;
  sessionId: string;
  testExecutableArgs?: string[];
  onVersion?: (version: CaseIqRunVersion) => Promise<void>;
}

interface Attempt {
  child: ChildProcessWithoutNullStreams;
  request: BridgeRequest;
  directory: string;
  done: Promise<number | null>;
  closed: boolean;
  spawnError: Error | null;
  stopping: Promise<void> | null;
}

export class CaseIqRunUnconfirmedError extends Error {
  constructor() {
    super("CaseIQ could not confirm that its owned process stopped. This Work remains reserved; retry cancellation and inspect local diagnostics.");
    this.name = "CaseIqRunUnconfirmedError";
  }
}

export function buildCaseIqEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = buildCopilotEnvironment(source);
  for (const name of [
    "GH_CONFIG_DIR", "COPILOT_ENTRA_DISABLE_ONEAUTH", "COPILOT_ENTRA_ONEAUTH",
    "COPILOT_ENTRA_ONEAUTH_SCOPE_BINDING_MODE",
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

class BridgeJournal {
  private position = 0;
  private sequence = 0;
  private pending = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly file: string, private readonly request: BridgeRequest) {}

  async read(): Promise<{ events: BridgeFrame[]; reachedEnd: boolean }> {
    const file = await open(this.file, "r").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!file) return { events: [], reachedEnd: true };
    const events: BridgeFrame[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let readBytes = 0;
    let reachedEnd = false;
    try {
      while (readBytes < 1024 * 1024) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.position);
        if (!bytesRead) { reachedEnd = true; break; }
        this.position += bytesRead;
        readBytes += bytesRead;
        this.pending += this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        let newline: number;
        while ((newline = this.pending.indexOf("\n")) >= 0) {
          const line = this.pending.slice(0, newline);
          this.pending = this.pending.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_BRIDGE_FILE_BYTES) throw new Error("CaseIQ journal frame is too large.");
          const event = nativeBridgeFrameSchema.parse(JSON.parse(line));
          assertBridgeCorrelation(event, this.request);
          if (event.sequence !== ++this.sequence) throw new Error("CaseIQ journal sequence is invalid.");
          events.push(event);
        }
        if (Buffer.byteLength(this.pending) > MAX_BRIDGE_FILE_BYTES) throw new Error("CaseIQ journal frame is too large.");
      }
    } finally { await file.close(); }
    return { events, reachedEnd };
  }

  finish(): void {
    this.pending += this.decoder.decode();
    if (this.pending) throw new Error("CaseIQ journal ends with an incomplete frame.");
  }
}

async function bridgeJson(file: string): Promise<unknown> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_BRIDGE_FILE_BYTES) throw new Error("CaseIQ bridge result is not a bounded regular file.");
  return JSON.parse(await readFile(file, "utf8"));
}

function completionIssue(completion: CopilotCompletionSummary): string | null {
  if (completion.openSubagents.length) return "background sub-agents are unfinished";
  if (completion.openTools.length) return "tool calls are unfinished";
  if (!completion.taskComplete && completion.rootFinalOutput === null) {
    return completion.aborted ? "the session aborted without a final response" : "no root-level final response was recorded";
  }
  return null;
}

class CaseIqOutputBuffer {
  private pending = "";

  constructor(private readonly deliver: (text: string) => void) {}

  push(text: string): void {
    this.pending += text;
    const newline = this.pending.lastIndexOf("\n");
    if (newline >= 0) {
      const complete = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      for (const line of complete.split("\n")) {
        if (Buffer.byteLength(line) > MAX_BRIDGE_FILE_BYTES) throw new Error("CaseIQ output line is too large.");
      }
      this.deliver(complete);
    }
    if (Buffer.byteLength(this.pending) > MAX_BRIDGE_FILE_BYTES) throw new Error("CaseIQ output line is too large.");
  }

  finish(): void {
    const tail = this.pending;
    this.pending = "";
    if (Buffer.byteLength(tail) > MAX_BRIDGE_FILE_BYTES) throw new Error("CaseIQ output line is too large.");
    if (tail) this.deliver(`${tail}\n`);
  }
}

export async function startCaseIqRun(options: CaseIqRunOptions): Promise<RunResult> {
  const privateRoot = getCaseIqStateRoot();
  let active: Attempt | null = null;
  let cancelled = false;
  let timedOut = false;
  let finalOutput: string | null = null;
  let model = options.model ?? null;
  let continuationCount = 0;
  let fallbackAttempted = false;
  let attemptNumber = 1;
  const reportStartup = (phase: CaseIqStartupPhase) =>
    reportCaseIqStartup(options.runId, cancelled || timedOut ? "stopping" : phase, attemptNumber);
  let pendingWrites = Promise.resolve();
  let writeError: unknown = null;
  let outputError: unknown = null;
  const logPath = getRunLogPath(options.runId);
  const command = `caseiq -p <prompt> --session-id ${options.sessionId}`;
  const timeoutMs = resolveCopilotTimeoutMs(options.timeoutSeconds);
  const maxIncompleteContinuations = options.maxIncompleteContinuations ?? 3;
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  const privatePrefixes = [privateRoot, privateRoot.replaceAll("\\", "/"), JSON.stringify(privateRoot).slice(1, -1)];
  const privatePathPattern = new RegExp(privatePrefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    process.platform === "win32" ? "gi" : "g");
  const redact = (text: string) => text.replace(privatePathPattern, "<private CaseIQ>");
  let recentOutput = "";
  const output = (text: string, stream: "stdout" | "stderr") => {
    const safeText = redact(text);
    recentOutput = (recentOutput + safeText).slice(-16_384);
    pendingWrites = pendingWrites.then(async () => {
      if (writeError !== null) return;
      await appendFile(logPath, safeText);
      const artifact = stream === "stdout" ? options.stdoutLogPath : options.stderrLogPath;
      if (artifact && artifact !== logPath) await appendFile(artifact, safeText);
    }).catch((error: unknown) => { writeError ??= error; });
    for (const line of safeText.split(/\r?\n/)) {
      if (line) emitter.emit("event", { type: "line", data: line } satisfies CopilotRunEvent);
    }
  };
  const buffers = {
    launcherStdout: new CaseIqOutputBuffer((text) => output(text, "stdout")),
    launcherStderr: new CaseIqOutputBuffer((text) => output(text, "stderr")),
    nativeStdout: new CaseIqOutputBuffer((text) => output(text, "stdout")),
    nativeStderr: new CaseIqOutputBuffer((text) => output(text, "stderr")),
  };
  const receive = (buffer: CaseIqOutputBuffer, text: string) => {
    if (outputError !== null || writeError !== null) return;
    try { buffer.push(text); }
    catch (error) { outputError ??= error; }
  };
  const flushOutput = () => {
    for (const buffer of Object.values(buffers)) {
      try { buffer.finish(); }
      catch (error) { outputError ??= error; }
    }
  };
  const stop = async (reason: "user" | "timeout" | "shutdown") => {
    const attempt = active;
    if (!attempt || attempt.closed) return;
    reportStartup("stopping");
    if (attempt.stopping) return attempt.stopping;
    attempt.stopping = (async () => {
      const cancel = path.join(attempt.directory, "cancel.json");
      try {
        const existing = await bridgeJson(cancel).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
        if (existing) assertBridgeCorrelation(nativeBridgeCancellationSchema.parse(existing), attempt.request);
        else {
          const temporary = `${cancel}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify({ ...bridgeCorrelation(attempt.request), action: "cancel", reason }), {
            flag: "wx", mode: 0o600,
          });
          await rename(temporary, cancel);
        }
      } catch (error) {
        console.error("[CaseIQ] Cancellation journal failed; stopping the owned wrapper process.", error);
        await stopCopilotProcess(attempt.child);
        await attempt.done;
        return;
      }
      let forceError: unknown = null;
      const force = setTimeout(() => {
        void stopCopilotProcess(attempt.child).catch((error: unknown) => { forceError = error; });
      }, 5000);
      try {
        while (!attempt.closed) {
          if (forceError) throw forceError;
          await sleep(25);
        }
      } finally { clearTimeout(force); }
    })().finally(() => { attempt.stopping = null; });
    return attempt.stopping;
  };
  const unregister = registerNativeRunControl(options.runId, async () => {
    cancelled = true;
    reportStartup("stopping");
    await stop("user");
    return true;
  });
  const emitter = createRunEmitter(options.runId);
  reportStartup("checking");
  const result = (exitCode: number | null, incompleteReason: string | null, usage: RunResult["usage"]): RunResult => {
    emitter.emit("event", { type: "exit", code: exitCode, timedOut, cancelled } satisfies CopilotRunEvent);
    return {
      exitCode, timedOut, cancelled, logPath, pid: active?.child.pid ?? null, command, model,
      cpuTimeMs: null, peakMemoryMb: null, finalOutput, incomplete: incompleteReason !== null,
      incompleteReason, continuationCount, usage,
    };
  };
  const cleanup = () => { clearCaseIqStartup(options.runId); unregister(); releaseRunEmitter(options.runId); };
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    for (const file of [options.stdoutLogPath, options.stderrLogPath]) {
      if (file) await mkdir(path.dirname(file), { recursive: true });
    }
    if (!options.prompt.trim() && !options.attachmentPaths?.length) {
      throw new Error("Enter a Prompt or attach files before running CaseIQ.");
    }
    output(`[Work Board] Preparing CaseIQ ${options.resumeSession ? "to resume the same session" : "to run your Prompt"}. Checking the trusted installation; no Terminal will open.\n`, "stdout");
    const prior = readNativeSessionBindingSync(options.sessionId);
    const baseline = prior?.home ? await readCopilotSessionInsights(options.sessionId) : null;
    let cursor = baseline?.eventCount ?? 0;
    let prompt = options.prompt.trim() ? options.prompt : "Please review the attached files.";
    let resume = options.resumeSession === true;
    let attachments = options.attachmentPaths ?? [];
    while (true) {
      await pendingWrites;
      if (writeError !== null) throw writeError;
      if (outputError !== null) throw outputError;
      if (cancelled) return result(null, null, null);
      if (deadline !== null && Date.now() >= deadline) { timedOut = true; return result(null, null, null); }
      recentOutput = "";
      reportStartup("checking");
      const spec = await prepareCaseIqPrompt({
        userId: options.userId, workId: options.workId, workingDirectory: options.repoPath,
        sessionId: options.sessionId, runId: options.runId, prompt, resume, attachments,
        sharedInputDirectory: options.pairedWorkspace?.inputDirectory,
        model, agent: options.agent, contextTier: options.contextTier, reasoningEffort: options.reasoningEffort,
        timeoutMs: deadline === null ? null : Math.max(50, deadline - Date.now()),
        testExecutableArgs: options.testExecutableArgs,
        onStartupStage: reportStartup,
      });
      if (cancelled) return result(null, null, null);
      if (deadline !== null && Date.now() >= deadline) { timedOut = true; return result(null, null, null); }
      const request = parseNativeBridgeRequest(await bridgeJson(spec.requestFile));
      const version: CaseIqRunVersion = {
        attemptId: request.attemptId, sourceCommit: request.sourceCommit ?? null,
        sourceBranch: request.sourceBranch ?? null, sourceDirty: request.sourceDirty ?? null,
        launcherSha256: request.launcherSha256, nativeVersion: request.nativeVersion,
      };
      output(`[Work Board] CaseIQ version: ${request.sourceCommit ?? "not recorded"}; branch ${JSON.stringify(request.sourceBranch ?? null)}; modified ${JSON.stringify(request.sourceDirty ?? null)}; CLI ${request.nativeVersion}; launcher SHA-256 ${request.launcherSha256}.\n`, "stdout");
      await options.onVersion?.(version);
      await pendingWrites;
      if (writeError !== null) throw writeError;
      if (cancelled) return result(null, null, null);
      if (deadline !== null && Date.now() >= deadline) { timedOut = true; return result(null, null, null); }
      reportStartup("launcher");
      const child = spawn(/* turbopackIgnore: true */ spec.powerShellExecutable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", spec.script, ...spec.arguments], {
        cwd: options.repoPath, windowsHide: true,
        env: workspaceInstructionEnvironment({ ...buildCaseIqEnvironment(), ...spec.environment }, options.pairedWorkspace),
      });
      const attempt: Attempt = {
        child, request, directory: path.dirname(spec.requestFile), closed: false, spawnError: null, stopping: null,
        done: new Promise<number | null>((resolve) => {
          child.once("error", (error) => { attempt.spawnError = error; });
          child.once("close", (code) => { attempt.closed = true; resolve(code); });
        }),
      };
      active = attempt;
      child.stdin.end();
      child.stdout.setEncoding("utf8").on("data", (data: string) => receive(buffers.launcherStdout, data));
      child.stderr.setEncoding("utf8").on("data", (data: string) => receive(buffers.launcherStderr, data));
      await options.onSpawn?.({ pid: child.pid ?? null, command, model });
      const journal = new BridgeJournal(path.join(attempt.directory, "journal.jsonl"), request);
      const tracker = new CopilotCompletionTracker();
      const preparationDeadline = Date.now() + 120_000;
      let accepted = false;
      let native: NativeResult | null = null;
      while (true) {
        if (writeError !== null) throw writeError;
        if (outputError !== null) throw outputError;
        if (cancelled || deadline !== null && Date.now() >= deadline) {
          timedOut ||= !cancelled;
          await stop(cancelled ? "user" : "timeout");
        }
        if (!accepted && !attempt.closed && Date.now() >= preparationDeadline) {
          throw new Error("CaseIQ initialization did not reach its native CLI within two minutes. Check the Run output for dependency/authentication setup errors. No Terminal or ordinary CLI fallback was opened.");
        }
        const batch = await journal.read();
        for (const event of batch.events) {
          if (event.kind === "prepared") {
            if (accepted) throw new Error("CaseIQ prepared more than one native invocation.");
            accepted = await acceptCaseIqPreparation({
              id: options.runId, workId: options.workId, copilotSessionId: options.sessionId,
            }, null, spec.requestFile);
            if (!accepted) throw new Error("CaseIQ native preparation was not accepted.");
            reportStartup("accepted");
            model = event.binding.model;
            output("[Work Board] CaseIQ preparation accepted. Ready to start your Prompt in WorkBoard.\n", "stdout");
          } else if (event.kind === "native-spawn") {
            if (!accepted) throw new Error("CaseIQ started a native process before its preparation was accepted.");
            reportStartup("native");
            output("[Work Board] CaseIQ Prompt process started. Output and Follow Up remain in WorkBoard.\n", "stdout");
          } else if (event.kind === "native-output") {
            if (!accepted) throw new Error("CaseIQ emitted native output before its preparation was accepted.");
            // Only the correlated native channel can provide completion evidence.
            if (event.stream === "stdout") {
              tracker.push(event.data);
              if (tracker.hasResponseActivity) reportStartup("processing");
            }
            receive(event.stream === "stdout" ? buffers.nativeStdout : buffers.nativeStderr, event.data);
          } else if (event.kind === "native-result") {
            if (native) throw new Error("CaseIQ returned more than one native result.");
            native = event;
          }
        }
        if (attempt.closed && batch.reachedEnd) { journal.finish(); break; }
        await sleep(50);
      }
      const code = await attempt.done;
      flushOutput();
      await pendingWrites;
      if (writeError !== null) throw writeError;
      if (outputError !== null) throw outputError;
      if (attempt.spawnError) throw attempt.spawnError;
      if (cancelled || timedOut) {
        const recordedLauncher = await stat(path.join(attempt.directory, "launcher-result.json")).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
        if (accepted && native?.pid && recordedLauncher?.isFile()) {
          await finalizeCaseIqSessionHome({
            id: options.runId, workId: options.workId, copilotSessionId: options.sessionId,
          }, spec.requestFile);
        }
        return result(code, null, null);
      }
      if (!native) throw new Error("CaseIQ exited without a confirmed native result. The request will not be replayed automatically.");
      const launcher = launcherResultSchema.parse(await bridgeJson(path.join(attempt.directory, "launcher-result.json")));
      assertBridgeCorrelation(launcher, request);
      if (launcher.nativeExitCode !== native.exitCode || code !== launcher.bridgeExitCode) {
        throw new Error("CaseIQ launcher and native process results disagree.");
      }
      if (!accepted || !launcher.nativeExecutionObserved || launcher.scriptError || native.error) {
        throw new Error(native.error?.message ?? "The original CaseIQ launcher failed before a verified native invocation completed. Inspect this Run's output.");
      }
      await finalizeCaseIqSessionHome({
        id: options.runId, workId: options.workId, copilotSessionId: options.sessionId,
      }, spec.requestFile);
      cancelled ||= native.cancelled;
      timedOut ||= native.timedOut;
      const insights = await readCopilotSessionInsights(options.sessionId, cursor).catch((error: unknown) => {
        if (native.exitCode !== 0 && error instanceof Error && "code" in error && error.code === "ENOENT") {
          return analyzeCopilotSessionEvents([]);
        }
        throw error;
      });
      const completion = insights.eventCount > cursor ? insights.completion : tracker.finish();
      const usage = subtractCopilotTokenUsage(insights.usage, baseline?.usage ?? null);
      finalOutput = completion.rootFinalOutput;
      const exitCode = code === 0 && launcher.bridgeExitCode === 0 ? native.exitCode : code || launcher.bridgeExitCode;
      if (cancelled || timedOut) return result(exitCode, null, usage);
      if (exitCode !== 0 && !fallbackAttempted && options.fallbackModel && options.fallbackModel !== model &&
          isModelUnavailableError(recentOutput)) {
        fallbackAttempted = true;
        model = options.fallbackModel;
        resume = insights.eventCount > 0;
        cursor = insights.eventCount;
        output("[Work Board] Retrying the same CaseIQ runtime with the selected fallback model.\n", "stderr");
        attemptNumber++;
        continue;
      }
      const issue = exitCode === 0
        ? insights.eventCount === 0 ? "the bound CaseIQ session history is unavailable" : completionIssue(completion)
        : null;
      if (issue && continuationCount < maxIncompleteContinuations && insights.eventCount > 0) {
        continuationCount++;
        resume = true;
        cursor = insights.eventCount;
        prompt = INCOMPLETE_SESSION_PROMPT;
        attachments = [];
        output(`[Work Board] CaseIQ exited before completion (${issue}); resuming the same CaseIQ session (${continuationCount}/${maxIncompleteContinuations}).\n`, "stderr");
        attemptNumber++;
        continue;
      }
      await pendingWrites;
      return result(exitCode, issue ? `CaseIQ exited before completion: ${issue}.` : null, usage);
    }
  } catch (error) {
    try { await stop("shutdown"); }
    catch (stopError) {
      console.error("[CaseIQ] Web runtime process cleanup failed.", stopError);
      emitter.emit("event", { type: "error", message: new CaseIqRunUnconfirmedError().message } satisfies CopilotRunEvent);
      throw new CaseIqRunUnconfirmedError();
    }
    const message = redact(error instanceof Error ? error.message : "CaseIQ web execution failed.");
    flushOutput();
    let reportedMessage = message;
    if (writeError !== null) {
      console.error("[CaseIQ] Run output could not be persisted.", writeError);
      reportedMessage = "CaseIQ output could not be saved. Check the Work output directory and server diagnostics; this Run was stopped rather than reported as successful.";
    }
    output(`[CaseIQ] ${reportedMessage}\n`, "stderr");
    await pendingWrites;
    emitter.emit("event", { type: "error", message: reportedMessage } satisfies CopilotRunEvent);
    throw new Error(reportedMessage, { cause: error });
  } finally {
    if (active && !active.closed) active.child.once("close", cleanup);
    else cleanup();
  }
}
