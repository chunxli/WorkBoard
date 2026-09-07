import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { buildCopilotEnvironment } from "@/lib/copilot-runner";
import {
  assertCopilotSessionNotInUse,
  readCompatibleCopilotSessionEvents,
  repairLegacyCopilotSessionEvents,
} from "@/lib/copilot-session-compat";
import { generateSecret, hashToken } from "@/lib/crypto";
import {
  getHeadCommit,
} from "@/lib/git-safety";
import {
  finalizeWorkRunArtifacts,
  getAutomationRunArtifactPaths,
  getWorkRunArtifactPaths,
  prepareRunArtifacts,
  readWorkRunSnapshot,
  serializeRunFinalization,
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import {
  captureRunSourceBaseline,
  captureRunSourceDiff,
  inheritRunSourceBaseline,
  isRunSourceBaselineReady,
} from "@/lib/run-source-snapshot";
import { getRepoWorkdirPath } from "@/lib/repo-workdir";
import { hashWorkContent, readWorkPrompt } from "@/lib/work-files";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import {
  analyzeCopilotSessionEvents,
  serializeCopilotTokenUsage,
  subtractCopilotTokenUsage,
} from "@/lib/copilot-session-insights";
import type { CopilotCompletionSummary } from "@/lib/copilot-completion";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { findActiveRunConflicts } from "@/lib/run-access";
import { getDirectorySnapshotPath } from "@/lib/directory-snapshot";

export class TerminalResumeInProgressError extends Error {
  constructor() {
    super("This Copilot session is already being opened in a terminal");
    this.name = "TerminalResumeInProgressError";
  }
}

export class TerminalResumeNotReadyError extends Error {
  constructor() {
    super("Terminal Resume baseline is not ready for this Run");
    this.name = "TerminalResumeNotReadyError";
  }
}

export class TerminalSyncInProgressError extends Error {
  constructor() {
    super("This terminal session is already being synchronized");
    this.name = "TerminalSyncInProgressError";
  }
}

const UNKNOWN_TERMINAL_EXIT_ERROR =
  "Terminal closed before reporting its exit status, and the Copilot session did not record a complete response";

export interface TerminalRunOutcome {
  status: "SUCCESS" | "FAILED";
  exitCode: number | null;
  errorMessage: string | null;
}

export function resolveTerminalRunOutcome(
  exitCode: number | null,
  completion: CopilotCompletionSummary
): TerminalRunOutcome {
  if (exitCode !== null) {
    return {
      status: exitCode === 0 ? "SUCCESS" : "FAILED",
      exitCode,
      errorMessage: exitCode === 0 ? null : `Copilot exited with code ${exitCode}`,
    };
  }

  const hasCompletionEvidence =
    completion.taskComplete || completion.rootFinalOutput !== null;
  const isComplete =
    hasCompletionEvidence &&
    completion.openSubagents.length === 0 &&
    completion.openTools.length === 0;
  return {
    status: isComplete ? "SUCCESS" : "FAILED",
    exitCode: null,
    errorMessage: isComplete ? null : UNKNOWN_TERMINAL_EXIT_ERROR,
  };
}

const MAX_WINDOWS_INITIAL_PROMPT_CHARACTERS = 20_000;

export interface NewTerminalSessionOptions {
  sessionId: string;
  workName: string;
  prompt: string;
  promptFileName: string;
  agent: string | null;
  model: string | null;
  contextTier: string | null;
  reasoningEffort: string | null;
  permissionMode: string | null;
}

export function buildNewTerminalSessionArgs(
  options: NewTerminalSessionOptions
): string[] {
  const initialPrompt = options.prompt.length <= MAX_WINDOWS_INITIAL_PROMPT_CHARACTERS
    ? options.prompt
    : `Read ${options.promptFileName} in the current directory and complete all instructions in it.`;
  const args = [
    "--session-id",
    options.sessionId,
    "--name",
    options.workName,
    "-i",
    initialPrompt,
    "--output-format",
    "text",
    options.permissionMode === "full" ? "--allow-all" : "--allow-all-tools",
  ];
  if (options.agent) args.push("--agent", options.agent);
  if (options.model) args.push("--model", options.model);
  if (options.contextTier) args.push("--context", options.contextTier);
  if (options.reasoningEffort) args.push("--effort", options.reasoningEffort);
  args.push("--secret-env-vars", "GH_TOKEN,GITHUB_TOKEN");
  return args;
}

function spawnDetached(executable: string, args: string[], cwd: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      env: buildCopilotEnvironment(),
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid ?? null);
    });
  });
}

function lastAssistantMessage(events: unknown[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as { type?: unknown; data?: { content?: unknown } };
    if (event.type === "assistant.message" && typeof event.data?.content === "string") {
      return event.data.content;
    }
  }
  return null;
}

async function readSessionEvents(sessionId: string, workingDirectory: string): Promise<unknown[]> {
  void workingDirectory;
  return readCompatibleCopilotSessionEvents(sessionId);
}

export async function launchTerminalResume(parentRunId: string): Promise<{
  runId: string;
  launcherPid: number | null;
}> {
  const candidate = await prisma.run.findUniqueOrThrow({
    where: { id: parentRunId },
    select: { copilotSessionId: true, workId: true, taskId: true },
  });
  if (!candidate.copilotSessionId) {
    throw new Error("This run does not have a resumable Copilot session");
  }
  const ownerKey = candidate.workId
    ? `work:${candidate.workId}`
    : `task:${candidate.taskId}`;
  try {
    return await withRunStartLock(
      [ownerKey, `session:${candidate.copilotSessionId}`],
      () => launchTerminalResumeUnlocked(parentRunId)
    );
  } catch (error) {
    if (error instanceof RunStartInProgressError) {
      throw new TerminalResumeInProgressError();
    }
    throw error;
  }
}

async function launchTerminalResumeUnlocked(parentRunId: string): Promise<{
  runId: string;
  launcherPid: number | null;
}> {
  const parentRun = await prisma.run.findUniqueOrThrow({
    where: { id: parentRunId },
    include: { work: true, task: { include: { repo: true } } },
  });
  if ((!parentRun.work && !parentRun.task) || !parentRun.copilotSessionId) {
    throw new Error("This run does not have a resumable Copilot session");
  }
  if (parentRun.status === "PENDING" || parentRun.status === "RUNNING") {
    throw new Error("Cannot resume a session while its run is still active");
  }
  if (parentRun.work?.status === "ARCHIVED" || parentRun.task?.archivedAt) {
    throw new Error("Restore this Work before resuming its session");
  }
  if (parentRun.hostname && parentRun.hostname !== hostname()) {
    throw new Error("This session belongs to another machine");
  }
  const activeOwnerRun = await prisma.run.findFirst({
    where: {
      ...(parentRun.workId
        ? { workId: parentRun.workId }
        : { taskId: parentRun.taskId }),
      status: { in: ["PENDING", "RUNNING"] },
    },
    select: { id: true },
  });
  if (activeOwnerRun) {
    throw new TerminalResumeInProgressError();
  }

  const work = parentRun.work;
  const task = parentRun.task;
  const executionPath =
    parentRun.executionPath ??
    work?.directoryPath ??
    (task ? getRepoWorkdirPath(task.repo) : null);
  if (!executionPath) throw new Error("The run has no working directory");
  const runId = randomUUID();
  const launchId = randomUUID();
  const callbackToken = generateSecret();
  const callbackUrl = new URL(
    "/api/terminal/callback",
    process.env.WORKBOARD_LOCAL_URL ?? "http://127.0.0.1:3100"
  ).toString();
  const paths = task
    ? getAutomationRunArtifactPaths(runId)
    : getWorkRunArtifactPaths(work!.directoryPath, runId);
  const parentPaths = task
    ? getAutomationRunArtifactPaths(parentRun.id)
    : getWorkRunArtifactPaths(work!.directoryPath, parentRun.id);
  const parentSnapshot = await readWorkRunSnapshot(parentPaths.snapshot).catch(() => null);
  if (!parentSnapshot?.finishedAt) throw new TerminalResumeNotReadyError();

  const sourceArtifactRoot = task ? parentPaths.outputDirectory : work!.directoryPath;
  const artifactRoot = task ? paths.outputDirectory : work!.directoryPath;
  const baselineReady = await isRunSourceBaselineReady({
    workDirectory: sourceArtifactRoot,
    runId: parentRun.id,
    gitTree: parentSnapshot.gitAfterTree,
  });
  if (!baselineReady) throw new TerminalResumeNotReadyError();

  const repairResult = await repairLegacyCopilotSessionEvents(parentRun.copilotSessionId);
  const beforeTree = await inheritRunSourceBaseline({
    sourceWorkDirectory: sourceArtifactRoot,
    sourceRunId: parentRun.id,
    sourceGitTree: parentSnapshot.gitAfterTree,
    targetWorkDirectory: artifactRoot,
    targetRunId: runId,
  });
  const baseCommit = await getHeadCommit(executionPath).catch(() => null);
  const sessionEventCursorStart = repairResult.eventCount;
  const startedAt = new Date();
  const prompt = parentRun.promptSnapshot ?? task?.prompt ?? work?.promptCache ?? "";
  const snapshot: WorkRunSnapshot = {
    schemaVersion: 1,
    runId,
    workId: parentRun.workId,
    workName: task?.name ?? work!.name,
    promptFileName: task ? null : work!.promptFileName,
    prompt,
    promptHash: hashWorkContent(prompt),
    engine: "CLI",
    sessionId: parentRun.copilotSessionId,
    executionPath,
    concurrencyMode: "EXTERNAL_TERMINAL",
    trigger: "TERMINAL_RESUME",
    resumedFromRunId: parentRun.id,
    status: "RUNNING",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    exitCode: null,
    errorMessage: null,
    gitBeforeTree: beforeTree,
    gitAfterTree: null,
    sessionEventCursorStart,
    taskId: parentRun.taskId,
    resourceName: task?.repo.name ?? null,
    agent: parentRun.agent,
    model: parentRun.model,
    fallbackModel: parentRun.fallbackModel,
    contextTier: parentRun.contextTier,
    reasoningEffort: parentRun.reasoningEffort,
    permissionMode: parentRun.permissionMode,
    outputFormat: "json",
    timeoutSeconds: null,
  };
  await prepareRunArtifacts(paths, snapshot);

  await prisma.$transaction([
    prisma.run.create({
      data: {
        id: runId,
        taskId: parentRun.taskId,
        workId: parentRun.workId,
        status: "RUNNING",
        trigger: "TERMINAL_RESUME",
        engine: "CLI",
        executionPath,
        promptSnapshot: snapshot.prompt,
        outputFormat: "json",
        agent: parentRun.agent,
        model: parentRun.model,
        fallbackModel: parentRun.fallbackModel,
        contextTier: parentRun.contextTier,
        reasoningEffort: parentRun.reasoningEffort,
        permissionMode: parentRun.permissionMode,
        outputDir: paths.outputDirectory,
        logPath: paths.stdout,
        copilotSessionId: parentRun.copilotSessionId,
        concurrencyMode: "EXTERNAL_TERMINAL",
        resumedFromRunId: parentRun.id,
        baseCommit,
        startedAt,
        hostname: hostname(),
        command: "copilot --resume=<session>",
      },
    }),
    prisma.terminalLaunch.create({
      data: {
        id: launchId,
        runId,
        tokenHash: hashToken(callbackToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    }),
  ]);

  const launchFile = path.join(process.cwd(), "data", "terminal-launches", `${launchId}.json`);
  const launcherScript = path.join(process.cwd(), "scripts", "workboard-resume.ps1");
  try {
    await mkdir(path.dirname(launchFile), { recursive: true });
    await writeFile(
      launchFile,
      JSON.stringify({
        sessionId: parentRun.copilotSessionId,
        workingDirectory: executionPath,
        callbackUrl,
        callbackToken,
      }),
      { encoding: "utf8", flag: "wx" }
    );
    const launcherPid = await spawnDetached(
      "wt.exe",
      [
        "--window",
        "new",
        "new-tab",
        "--startingDirectory",
        executionPath,
        "--title",
        `Work Board ${runId.slice(0, 8)}`,
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcherScript,
        "-LaunchFile",
        launchFile,
      ],
      executionPath
    );
    await prisma.terminalLaunch.updateMany({
      where: { id: launchId, status: "PENDING" },
      data: { status: "LAUNCHED", launcherPid, launchedAt: new Date() },
    });
    return { runId, launcherPid };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    await finalizeWorkRunArtifacts({
      paths,
      snapshot: { ...snapshot, status: "FAILED", finishedAt: finishedAt.toISOString(), errorMessage },
      finalOutput: null,
      diff: "",
    });
    await prisma.$transaction([
      prisma.run.update({
        where: { id: runId },
        data: { status: "FAILED", errorMessage, finishedAt },
      }),
      prisma.terminalLaunch.update({
        where: { id: launchId },
        data: { status: "FAILED", errorMessage, completedAt: finishedAt },
      }),
    ]);
    await rm(launchFile, { force: true }).catch(() => {});
    throw error;
  }
}

export async function isTerminalResumeReady(run: {
  id: string;
  taskId: string | null;
  status: string;
  work: { directoryPath: string } | null;
}): Promise<boolean> {
  if (run.status === "PENDING" || run.status === "RUNNING") return false;
  const paths = run.taskId
    ? getAutomationRunArtifactPaths(run.id)
    : run.work
      ? getWorkRunArtifactPaths(run.work.directoryPath, run.id)
      : null;
  if (!paths) return false;

  const snapshot = await readWorkRunSnapshot(paths.snapshot).catch(() => null);
  if (!snapshot?.finishedAt) return false;
  return isRunSourceBaselineReady({
    workDirectory: run.taskId ? paths.outputDirectory : run.work!.directoryPath,
    runId: run.id,
    gitTree: snapshot.gitAfterTree,
  });
}

export async function finalizeFailedTerminalRun(
  runId: string,
  errorMessage: string,
  finishedAt = new Date()
): Promise<boolean> {
  return serializeRunFinalization(runId, async () => {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { work: true, task: { include: { repo: true } } },
    });
    if (!run || !isTerminalRunTrigger(run.trigger)) return false;
    if (run.status !== "RUNNING") return false;

    const paths = run.task
      ? getAutomationRunArtifactPaths(run.id)
      : run.work
        ? getWorkRunArtifactPaths(run.work.directoryPath, run.id)
        : null;
    const executionPath =
      run.executionPath ??
      run.work?.directoryPath ??
      (run.task ? getRepoWorkdirPath(run.task.repo) : null);
    if (paths && executionPath) {
      const snapshot = await readWorkRunSnapshot(paths.snapshot).catch(() => null);
      if (snapshot) {
        const artifactRoot = run.task ? paths.outputDirectory : run.work!.directoryPath;
        const sourceDiff = await captureRunSourceDiff({
          executionPath,
          workDirectory: artifactRoot,
          runId: run.id,
          beforeGitTree: snapshot.gitBeforeTree,
        }).catch(() => ({ afterGitTree: null, diff: "" }));
        await finalizeWorkRunArtifacts({
          paths,
          snapshot: {
            ...snapshot,
            status: "FAILED",
            finishedAt: finishedAt.toISOString(),
            errorMessage,
            gitAfterTree: sourceDiff.afterGitTree,
          },
          finalOutput: null,
          diff: sourceDiff.diff,
        }).catch(() => {});
      }
    }

    const updated = await prisma.run.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: { status: "FAILED", errorMessage, finishedAt },
    });
    if (updated.count === 0) return false;
    if (run.work) {
      const activeRuns = await prisma.run.count({
        where: {
          workId: run.work.id,
          id: { not: run.id },
          status: { in: ["PENDING", "RUNNING"] },
        },
      });
      if (activeRuns === 0) {
        await prisma.work.update({
          where: { id: run.work.id },
          data: { status: "ACTIVE" },
        });
      }
    }
    return true;
  });
}

export async function syncTerminalRun(
  runId: string,
  exitCode?: number
): Promise<"synced" | "already-synced"> {
  try {
    return await withRunStartLock([`terminal-sync:${runId}`], () =>
      syncTerminalRunUnlocked(runId, exitCode, false)
    );
  } catch (error) {
    if (error instanceof RunStartInProgressError) {
      throw new TerminalSyncInProgressError();
    }
    throw error;
  }
}

export async function syncExpiredTerminalRun(
  runId: string,
  exitCode: number
): Promise<"synced" | "already-synced"> {
  try {
    return await withRunStartLock([`terminal-sync:${runId}`], () =>
      syncTerminalRunUnlocked(runId, exitCode, true)
    );
  } catch (error) {
    if (error instanceof RunStartInProgressError) {
      throw new TerminalSyncInProgressError();
    }
    throw error;
  }
}

async function syncTerminalRunUnlocked(
  runId: string,
  exitCode: number | undefined,
  allowExpired: boolean
): Promise<"synced" | "already-synced"> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { work: true, task: { include: { repo: true } } },
  });
  if ((!run.work && !run.task) || !run.copilotSessionId || !isTerminalRunTrigger(run.trigger)) {
    throw new Error("Run is not a resumable terminal session");
  }
  await assertCopilotSessionNotInUse(run.copilotSessionId);

  const terminalLaunch = await prisma.terminalLaunch.findUniqueOrThrow({
    where: { runId },
    select: { id: true },
  });
  const persistedExitCode = exitCode ?? await tryReadTerminalLaunchExitCode(terminalLaunch.id);

  const now = new Date();
  const claim = await prisma.terminalLaunch.updateMany({
    where: {
      runId,
      status: { in: ["PENDING", "LAUNCHED", "SYNCING", "FAILED"] },
      ...(allowExpired
        ? { expiresAt: { lte: now }, run: { status: "RUNNING" as const } }
        : { completedAt: null, expiresAt: { gt: now } }),
    },
    data: { status: "SYNCING", completedAt: null, errorMessage: null },
  });
  if (claim.count === 0) {
    const launch = await prisma.terminalLaunch.findUnique({ where: { runId } });
    if (launch?.status === "COMPLETED") return "already-synced";
    if (launch?.completedAt || launch && launch.expiresAt <= now) {
      throw new Error("This terminal session has expired and can no longer be synchronized");
    }
    throw new Error("This terminal session is already being synchronized");
  }

  const paths = run.task
    ? getAutomationRunArtifactPaths(run.id)
    : getWorkRunArtifactPaths(run.work!.directoryPath, run.id);
  const priorSnapshot = await readWorkRunSnapshot(paths.snapshot);
  const executionPath =
    run.executionPath ??
    run.work?.directoryPath ??
    (run.task ? getRepoWorkdirPath(run.task.repo) : null);
  if (!executionPath) throw new Error("The run has no working directory");
  const artifactRoot = run.task ? paths.outputDirectory : run.work!.directoryPath;

  try {
    const allEvents = await readSessionEvents(
      run.copilotSessionId,
      executionPath
    );
    const cursor = priorSnapshot.sessionEventCursorStart ?? 0;
    const events = cursor <= allEvents.length ? allEvents.slice(cursor) : allEvents;
    const currentInsights = analyzeCopilotSessionEvents(allEvents, cursor);
    const priorUsage = analyzeCopilotSessionEvents(allEvents.slice(0, cursor)).usage;
    const usageData = serializeCopilotTokenUsage(
      subtractCopilotTokenUsage(currentInsights.usage, priorUsage)
    );
    const transcript = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(paths.stdout, transcript ? `${transcript}\n` : "", "utf8");

    const sourceDiff = await captureRunSourceDiff({
      executionPath,
      workDirectory: artifactRoot,
      runId: run.id,
      beforeGitTree: priorSnapshot.gitBeforeTree,
    });
    const afterTree = sourceDiff.afterGitTree;
    const finalCommit = await getHeadCommit(executionPath).catch(() => null);
    const diff = sourceDiff.diff;
    const finalOutput = currentInsights.completion.rootFinalOutput ?? lastAssistantMessage(events);
    const finishedAt = new Date();
    const outcome = resolveTerminalRunOutcome(
      persistedExitCode,
      currentInsights.completion
    );

    await finalizeWorkRunArtifacts({
      paths,
      snapshot: {
        ...priorSnapshot,
        status: outcome.status,
        exitCode: outcome.exitCode,
        finishedAt: finishedAt.toISOString(),
        gitAfterTree: afterTree,
        errorMessage: outcome.errorMessage,
        ...usageData,
      },
      finalOutput,
      diff,
    });
    await prisma.$transaction([
      prisma.run.update({
        where: { id: run.id },
        data: {
          status: outcome.status,
          exitCode: outcome.exitCode,
          finalOutput,
          finalCommit,
          finishedAt,
          errorMessage: outcome.errorMessage,
          ...usageData,
        },
      }),
      prisma.terminalLaunch.updateMany({
        where: { runId: run.id, status: "SYNCING" },
        data: { status: "COMPLETED", completedAt: finishedAt, errorMessage: null },
      }),
    ]);
    if (run.work) {
      await prisma.work.update({
        where: { id: run.work.id },
        data: { status: outcome.status === "SUCCESS" ? "REVIEW" : "ACTIVE" },
      });
    }
    await rm(
      path.join(process.cwd(), "data", "terminal-launches", `${terminalLaunch.id}.json`),
      { force: true }
    ).catch(() => {});
    return "synced";
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await prisma.$transaction([
      prisma.terminalLaunch.updateMany({
        where: { runId: run.id, status: "SYNCING" },
        data: { status: "FAILED", errorMessage },
      }),
      prisma.run.update({
        where: { id: run.id },
        data: { errorMessage, finishedAt: null },
      }),
    ]);
    throw error;
  }
}

export function parseTerminalLaunchExitCode(content: string): number {
  const launch = JSON.parse(content.replace(/^\uFEFF/, "")) as { exitCode?: unknown };
  if (
    typeof launch.exitCode !== "number" ||
    !Number.isInteger(launch.exitCode) ||
    launch.exitCode < -1 ||
    launch.exitCode > 2_147_483_647
  ) {
    throw new Error("Terminal exit status is unavailable; wait for the terminal callback or retry.");
  }
  return launch.exitCode;
}

async function readTerminalLaunchExitCode(launchId: string): Promise<number> {
  const launchFile = path.join(
    process.cwd(),
    "data",
    "terminal-launches",
    `${launchId}.json`
  );
  try {
    return parseTerminalLaunchExitCode(await readFile(launchFile, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Terminal exit status could not be read; retry after the terminal closes.");
    }
    throw error;
  }
}

export class TerminalStartError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "TerminalStartError";
  }
}

function describeTerminalCommand(copilotArgs: string[]): string {
  return `copilot ${copilotArgs
    .map((argument, index) => copilotArgs[index - 1] === "-i" ? "<prompt>" : argument)
    .join(" ")}`;
}

export async function launchNewWorkTerminal(
  userId: string,
  workId: string
): Promise<{ runId: string; launcherPid: number | null }> {
  try {
    return await withRunStartLock([`work:${workId}`], async () => {
      const work = await prisma.work.findFirst({ where: { id: workId, userId } });
      if (!work) throw new TerminalStartError("Work not found", 404);
      if (work.status === "ARCHIVED") {
        throw new TerminalStartError("Restore this Work before opening Terminal");
      }
      const priorRun = await prisma.run.findFirst({
        where: { workId: work.id },
        select: { id: true },
      });
      if (priorRun) {
        throw new TerminalStartError("A first Terminal session can only be opened before the Work has run");
      }
      if ((await findActiveRunConflicts(userId, work.directoryPath)).length > 0) {
        throw new TerminalStartError("Wait for the active Run in this Work directory to finish");
      }

      const savedPrompt = await readWorkPrompt(work);
      const runId = randomUUID();
      const launchId = randomUUID();
      const sessionId = randomUUID();
      const callbackToken = generateSecret();
      const callbackUrl = new URL(
        "/api/terminal/callback",
        process.env.WORKBOARD_LOCAL_URL ?? "http://127.0.0.1:3100"
      ).toString();
      const paths = getWorkRunArtifactPaths(work.directoryPath, runId);
      const beforeTree = await captureRunSourceBaseline(
        work.directoryPath,
        work.directoryPath,
        runId
      );
      const baseCommit = await getHeadCommit(work.directoryPath).catch(() => null);
      const startedAt = new Date();
      const copilotArgs = buildNewTerminalSessionArgs({
        sessionId,
        workName: work.name,
        prompt: savedPrompt.content,
        promptFileName: work.promptFileName,
        agent: work.agent,
        model: work.model,
        contextTier: work.contextTier,
        reasoningEffort: work.reasoningEffort,
        permissionMode: work.permissionMode,
      });
      const command = describeTerminalCommand(copilotArgs);
      const snapshot: WorkRunSnapshot = {
        schemaVersion: 1,
        runId,
        workId: work.id,
        workName: work.name,
        promptFileName: work.promptFileName,
        prompt: savedPrompt.content,
        promptHash: savedPrompt.hash,
        engine: "CLI",
        sessionId,
        executionPath: work.directoryPath,
        concurrencyMode: "EXTERNAL_TERMINAL",
        trigger: "TERMINAL_START",
        resumedFromRunId: null,
        status: "RUNNING",
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        exitCode: null,
        errorMessage: null,
        gitBeforeTree: beforeTree,
        gitAfterTree: null,
        sessionEventCursorStart: 0,
        agent: work.agent,
        model: work.model,
        fallbackModel: null,
        contextTier: work.contextTier,
        reasoningEffort: work.reasoningEffort,
        permissionMode: work.permissionMode,
        outputFormat: "text",
        timeoutSeconds: null,
      };
      await prepareRunArtifacts(paths, snapshot);
      await prisma.$transaction([
        prisma.run.create({
          data: {
            id: runId,
            workId: work.id,
            status: "RUNNING",
            trigger: "TERMINAL_START",
            engine: "CLI",
            executionPath: work.directoryPath,
            promptSnapshot: savedPrompt.content,
            outputFormat: "text",
            agent: work.agent,
            model: work.model,
            fallbackModel: null,
            contextTier: work.contextTier,
            reasoningEffort: work.reasoningEffort,
            permissionMode: work.permissionMode,
            outputDir: paths.outputDirectory,
            logPath: paths.stdout,
            copilotSessionId: sessionId,
            concurrencyMode: "EXTERNAL_TERMINAL",
            baseCommit,
            startedAt,
            hostname: hostname(),
            command,
          },
        }),
        prisma.terminalLaunch.create({
          data: {
            id: launchId,
            runId,
            tokenHash: hashToken(callbackToken),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        }),
      ]);

      const launchFile = path.join(
        process.cwd(),
        "data",
        "terminal-launches",
        `${launchId}.json`
      );
      const launcherScript = path.join(process.cwd(), "scripts", "workboard-resume.ps1");
      let launcherPid: number | null;
      try {
        await mkdir(path.dirname(launchFile), { recursive: true });
        await writeFile(
          launchFile,
          JSON.stringify({
            mode: "new",
            sessionId,
            workingDirectory: work.directoryPath,
            callbackUrl,
            callbackToken,
            copilotArgs,
          }),
          { encoding: "utf8", flag: "wx" }
        );
        launcherPid = await spawnDetached(
          "wt.exe",
          [
            "--window",
            "new",
            "new-tab",
            "--startingDirectory",
            work.directoryPath,
            "--title",
            `Work Board ${runId.slice(0, 8)}`,
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            launcherScript,
            "-LaunchFile",
            launchFile,
          ],
          work.directoryPath
        );
      } catch (error) {
        await prisma.$transaction([
          prisma.terminalLaunch.deleteMany({ where: { id: launchId } }),
          prisma.run.deleteMany({ where: { id: runId } }),
        ]);
        await Promise.all([
          rm(launchFile, { force: true }).catch(() => {}),
          rm(paths.outputDirectory, { recursive: true, force: true }).catch(() => {}),
          rm(getDirectorySnapshotPath(work.directoryPath, runId), { force: true }).catch(() => {}),
        ]);
        throw error;
      }
      await prisma.terminalLaunch.updateMany({
        where: { id: launchId, status: "PENDING" },
        data: { status: "LAUNCHED", launcherPid, launchedAt: new Date() },
      }).catch((error) => {
        console.warn(`[terminal] Run ${runId} opened but launch metadata was not updated:`, error);
      });
      return { runId, launcherPid };
    });
  } catch (error) {
    if (error instanceof RunStartInProgressError) {
      throw new TerminalStartError("A Run is already being started for this Work");
    }
    throw error;
  }
}

export async function tryReadTerminalLaunchExitCode(
  launchId: string
): Promise<number | null> {
  try {
    return await readTerminalLaunchExitCode(launchId);
  } catch {
    return null;
  }
}