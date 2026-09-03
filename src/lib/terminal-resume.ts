import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import {
  captureRunSourceDiff,
  inheritRunSourceBaseline,
  isRunSourceBaselineReady,
} from "@/lib/run-source-snapshot";
import { getRepoWorkdirPath } from "@/lib/repo-workdir";
import { hashWorkContent } from "@/lib/work-files";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import {
  analyzeCopilotSessionEvents,
  serializeCopilotTokenUsage,
  subtractCopilotTokenUsage,
} from "@/lib/copilot-session-insights";

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
    await prisma.terminalLaunch.update({
      where: { id: launchId },
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

export async function syncTerminalRun(
  runId: string,
  exitCode = 0
): Promise<"synced" | "already-synced"> {
  try {
    return await withRunStartLock([`terminal-sync:${runId}`], () =>
      syncTerminalRunUnlocked(runId, exitCode)
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
  exitCode: number
): Promise<"synced" | "already-synced"> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { work: true, task: { include: { repo: true } } },
  });
  if ((!run.work && !run.task) || !run.copilotSessionId || run.trigger !== "TERMINAL_RESUME") {
    throw new Error("Run is not a resumable terminal session");
  }
  await assertCopilotSessionNotInUse(run.copilotSessionId);

  const claim = await prisma.terminalLaunch.updateMany({
    where: { runId, status: { in: ["PENDING", "LAUNCHED", "SYNCING", "FAILED"] } },
    data: { status: "SYNCING", errorMessage: null },
  });
  if (claim.count === 0) {
    const launch = await prisma.terminalLaunch.findUnique({ where: { runId } });
    if (launch?.status === "COMPLETED") return "already-synced";
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
    const finalOutput = lastAssistantMessage(events);
    const finishedAt = new Date();
    const status = exitCode === 0 ? "SUCCESS" : "FAILED";

    await finalizeWorkRunArtifacts({
      paths,
      snapshot: {
        ...priorSnapshot,
        status,
        exitCode,
        finishedAt: finishedAt.toISOString(),
        gitAfterTree: afterTree,
        errorMessage: exitCode === 0 ? null : `Copilot exited with code ${exitCode}`,
        ...usageData,
      },
      finalOutput,
      diff,
    });
    await prisma.$transaction([
      prisma.run.update({
        where: { id: run.id },
        data: {
          status,
          exitCode,
          finalOutput,
          finalCommit,
          finishedAt,
          errorMessage: exitCode === 0 ? null : `Copilot exited with code ${exitCode}`,
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
        data: { status: exitCode === 0 ? "REVIEW" : "ACTIVE" },
      });
    }
    return "synced";
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    await prisma.$transaction([
      prisma.terminalLaunch.updateMany({
        where: { runId: run.id, status: "SYNCING" },
        data: { status: "FAILED", errorMessage },
      }),
      prisma.run.update({
        where: { id: run.id },
        data: { status: "FAILED", errorMessage, finishedAt },
      }),
    ]);
    if (run.work) {
      await prisma.work.update({ where: { id: run.work.id }, data: { status: "ACTIVE" } });
    }
    throw error;
  }
}