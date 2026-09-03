import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import {
  getRepoWorkdirPath,
  resolveRepoWorkdir,
  syncRepoToDefaultBranch,
} from "@/lib/repo-workdir";
import { createSafeBranch, getHeadCommit, isGitRepo } from "@/lib/git-safety";
import {
  extractFinalCopilotOutput,
  startCopilotRun,
  type RunPermissionMode,
  type RunOutputFormat,
} from "@/lib/copilot-runner";
import type { RunTrigger } from "@/generated/prisma/client";
import {
  finalizeWorkRunArtifacts,
  getAutomationRunArtifactPaths,
  prepareRunArtifacts,
  readWorkRunSnapshot,
  serializeRunFinalization,
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import { serializeCopilotTokenUsage } from "@/lib/copilot-session-insights";
import { captureRunSourceBaseline, captureRunSourceDiff } from "@/lib/run-source-snapshot";
import { hashWorkContent } from "@/lib/work-files";

/** Creates the PENDING Run row up-front so callers can return its id immediately. */
export async function createPendingRun(taskId: string, trigger: RunTrigger) {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { repo: true },
  });
  const runId = randomUUID();
  const paths = getAutomationRunArtifactPaths(runId);
  return prisma.run.create({
    data: {
      id: runId,
      taskId,
      workId: task.workId,
      trigger,
      status: "PENDING",
      engine: "CLI",
      executionPath: getRepoWorkdirPath(task.repo),
      promptSnapshot: task.prompt,
      outputFormat: task.outputFormat,
      timeoutSeconds: task.timeoutSeconds,
      agent: task.agent,
      model: task.model,
      fallbackModel: task.fallbackModel,
      contextTier: task.contextTier,
      reasoningEffort: task.reasoningEffort,
      permissionMode: task.permissionMode,
      outputDir: paths.outputDirectory,
      copilotSessionId: randomUUID(),
      concurrencyMode: "AUTOMATION",
    },
  });
}

/**
 * Executes a previously-created PENDING Run: resolves the repo, optionally creates a
 * safety branch, invokes the Copilot CLI, and persists the Run's outcome.
 * Intended to be called from inside the job queue (one at a time / bounded concurrency).
 */
export async function executeRun(runId: string): Promise<void> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { task: { include: { repo: true } } },
  });
  const task = run.task;
  if (!task) throw new Error(`Automation run ${run.id} has no Task`);

  if (run.status === "CANCELLED") {
    await finalizeAutomationRun(run.id, "CANCELLED", "Run was cancelled before it started.");
    return;
  }
  if (task.archivedAt) {
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "CANCELLED" },
    });
    await finalizeAutomationRun(run.id, "CANCELLED", "Automation was archived before this run started.");
    return;
  }

  const paths = getAutomationRunArtifactPaths(run.id);
  const prompt = run.promptSnapshot ?? task.prompt;
  const sessionId = run.copilotSessionId ?? randomUUID();
  const outputFormat: RunOutputFormat =
    (run.outputFormat ?? task.outputFormat) === "json" ? "json" : "text";
  const timeoutSeconds = run.timeoutSeconds ?? task.timeoutSeconds;
  const model = run.model ?? task.model;
  const contextTier = run.contextTier ?? task.contextTier;
  const reasoningEffort = run.reasoningEffort ?? task.reasoningEffort;
  let repoPath = run.executionPath ?? getRepoWorkdirPath(task.repo);
  let beforeTree: string | null = null;

  try {
    const startedAt = new Date();
    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: "PENDING" },
      data: {
        status: "RUNNING",
        startedAt,
        engine: "CLI",
        executionPath: repoPath,
        promptSnapshot: prompt,
        outputFormat,
        model,
        contextTier,
        reasoningEffort,
        hostname: hostname(),
        logPath: paths.stdout,
        outputDir: paths.outputDirectory,
        copilotSessionId: sessionId,
      },
    });
    if (claimed.count === 0) return;

    repoPath = await resolveRepoWorkdir(task.repo);
    await syncRepoToDefaultBranch(task.repo, repoPath);
    if (await isCancelled(run.id)) {
      await finalizeAutomationRun(run.id, "CANCELLED", "Run was cancelled during repository setup.");
      return;
    }
    let branchName: string | null = null;
    const baseCommit = await getHeadCommit(repoPath);

    if (task.useSafeBranch && (await isGitRepo(repoPath))) {
      branchName = await createSafeBranch(repoPath, run.id, task.repo.defaultBranch);
    }
    beforeTree = await captureRunSourceBaseline(repoPath, paths.outputDirectory, run.id);
    const runningSnapshot = createAutomationSnapshot({
      run,
      task,
      prompt,
      sessionId,
      executionPath: repoPath,
      status: "RUNNING",
      startedAt,
      beforeTree,
    });
    await prepareRunArtifacts(paths, runningSnapshot);
    if (await isCancelled(run.id)) {
      await finalizeAutomationRun(run.id, "CANCELLED", "Run was cancelled during repository setup.");
      return;
    }

    const prepared = await prisma.run.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: {
        branchName,
        baseCommit,
        executionPath: repoPath,
      },
    });
    if (prepared.count === 0 || (await isCancelled(run.id))) {
      await finalizeAutomationRun(run.id, "CANCELLED", "Run was cancelled before Copilot started.");
      return;
    }

    const permissionMode: RunPermissionMode = task.permissionMode === "full" ? "full" : "default";

    const result = await startCopilotRun({
      runId: run.id,
      sessionId,
      repoPath,
      prompt,
      agent: task.agent,
      model,
      fallbackModel: task.fallbackModel,
      contextTier,
      reasoningEffort,
      permissionMode,
      outputFormat,
      timeoutSeconds,
      maxIncompleteContinuations: 3,
      stdoutLogPath: paths.stdout,
      stderrLogPath: paths.stderr,
      onSpawn: ({ pid, command, model }) => {
        void prisma.run
          .update({ where: { id: run.id }, data: { pid, command, model } })
          .catch(() => {});
      },
    });

    const sourceDiff = await captureRunSourceDiff({
      executionPath: repoPath,
      workDirectory: paths.outputDirectory,
      runId: run.id,
      beforeGitTree: beforeTree,
    });
    const finalCommit = await getHeadCommit(repoPath).catch(() => null);
    const stdout = await readFile(paths.stdout, "utf8").catch(() => "");
    const finalOutput = result.incomplete
      ? null
      : result.finalOutput ?? extractFinalCopilotOutput(stdout);
    const status = result.cancelled
      ? "CANCELLED"
      : result.timedOut
        ? "TIMED_OUT"
        : result.incomplete
          ? "FAILED"
          : result.exitCode === 0
            ? "SUCCESS"
            : "FAILED";
    const errorMessage = result.incompleteReason;
    const usageData = serializeCopilotTokenUsage(result.usage);
    const finishedAt = new Date();
    await finalizeWorkRunArtifacts({
      paths,
      snapshot: {
        ...runningSnapshot,
        status,
        finishedAt: finishedAt.toISOString(),
        exitCode: result.exitCode,
        errorMessage,
        gitAfterTree: sourceDiff.afterGitTree,
        ...usageData,
      },
      finalOutput,
      diff: sourceDiff.diff,
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status,
        finalCommit,
        finalOutput,
        errorMessage,
        exitCode: result.exitCode,
        model: result.model,
        logPath: paths.stdout,
        outputDir: paths.outputDirectory,
        finishedAt,
        cpuTimeMs: result.cpuTimeMs,
        peakMemoryMb: result.peakMemoryMb,
        ...usageData,
      },
    });
  } catch (err) {
    const cancelled = await isCancelled(run.id);
    await finalizeAutomationRun(
      run.id,
      cancelled ? "CANCELLED" : "FAILED",
      cancelled ? "Run was cancelled." : null,
      cancelled ? null : err instanceof Error ? err.message : String(err)
    );
  }
}

function createAutomationSnapshot(options: {
  run: Awaited<ReturnType<typeof prisma.run.findUniqueOrThrow>>;
  task: NonNullable<Awaited<ReturnType<typeof prisma.task.findUniqueOrThrow>>> & {
    repo: { name: string };
  };
  prompt: string;
  sessionId: string;
  executionPath: string;
  status: string;
  startedAt: Date | null;
  beforeTree: string | null;
}): WorkRunSnapshot {
  return {
    schemaVersion: 1,
    runId: options.run.id,
    workId: options.run.workId,
    workName: options.task.name,
    promptFileName: null,
    prompt: options.prompt,
    promptHash: hashWorkContent(options.prompt),
    engine: "CLI",
    sessionId: options.sessionId,
    executionPath: options.executionPath,
    concurrencyMode: "AUTOMATION",
    status: options.status,
    startedAt: options.startedAt?.toISOString() ?? null,
    finishedAt: null,
    exitCode: null,
    errorMessage: null,
    gitBeforeTree: options.beforeTree,
    gitAfterTree: null,
    taskId: options.task.id,
    resourceName: options.task.repo.name,
    outputFormat: options.run.outputFormat,
    timeoutSeconds: options.run.timeoutSeconds,
  };
}

export async function finalizeAutomationRun(
  runId: string,
  status: "CANCELLED" | "FAILED",
  finalOutput: string | null,
  errorMessage: string | null = null
): Promise<void> {
  await serializeRunFinalization(runId, () =>
    finalizeAutomationRunUnlocked(runId, status, finalOutput, errorMessage)
  );
}

async function finalizeAutomationRunUnlocked(
  runId: string,
  status: "CANCELLED" | "FAILED",
  finalOutput: string | null,
  errorMessage: string | null
): Promise<void> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { task: { include: { repo: true } } },
  });
  if (!run.task) return;
  if (run.finishedAt && run.outputDir) return;
  const paths = getAutomationRunArtifactPaths(run.id);
  const executionPath = run.executionPath ?? getRepoWorkdirPath(run.task.repo);
  let snapshot = await readWorkRunSnapshot(paths.snapshot).catch(() => null);
  if (!snapshot) {
    snapshot = createAutomationSnapshot({
      run,
      task: run.task,
      prompt: run.promptSnapshot ?? run.task.prompt,
      sessionId: run.copilotSessionId ?? "unknown",
      executionPath,
      status: run.status,
      startedAt: run.startedAt,
      beforeTree: null,
    });
    await prepareRunArtifacts(paths, snapshot);
  }
  const sourceDiff = await captureRunSourceDiff({
    executionPath,
    workDirectory: paths.outputDirectory,
    runId: run.id,
    beforeGitTree: snapshot.gitBeforeTree,
  }).catch(() => ({ afterGitTree: null, diff: "" }));
  const finishedAt = new Date();
  await finalizeWorkRunArtifacts({
    paths,
    snapshot: {
      ...snapshot,
      status,
      finishedAt: finishedAt.toISOString(),
      errorMessage,
      gitAfterTree: sourceDiff.afterGitTree,
    },
    finalOutput,
    diff: sourceDiff.diff,
  });
  const finalCommit = await getHeadCommit(executionPath).catch(() => null);
  await prisma.run.update({
    where: { id: run.id },
    data: {
      status,
      finalCommit,
      finalOutput,
      errorMessage,
      outputDir: paths.outputDirectory,
      logPath: paths.stdout,
      finishedAt,
    },
  });
}

async function isCancelled(runId: string): Promise<boolean> {
  const current = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
  return current?.status === "CANCELLED";
}

/** Convenience helper for callers that don't need the run id ahead of time. */
export async function executeTaskRun(taskId: string, trigger: RunTrigger): Promise<string> {
  const run = await createPendingRun(taskId, trigger);
  await executeRun(run.id);
  return run.id;
}
