import { prisma } from "@/lib/prisma";
import { jobQueue } from "@/lib/job-queue";
import { executeRun, finalizeAutomationRun } from "@/lib/task-executor";
import {
  executeWorkRun,
  finalizeCancelledWorkRun,
  getWorkRunQueueKey,
} from "@/lib/work-executor";
import {
  finalizeWorkRunArtifacts,
  getWorkRunArtifactPaths,
  prepareWorkRunArtifacts,
  readWorkRunSnapshot,
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import { hashWorkContent } from "@/lib/work-files";
import { captureRunSourceDiff } from "@/lib/run-source-snapshot";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { TERMINAL_RUN_TRIGGERS } from "@/lib/terminal-run";

const globalForRecovery = globalThis as unknown as { workBoardRecoveryStarted?: boolean };

export async function recoverRuns(): Promise<void> {
  if (globalForRecovery.workBoardRecoveryStarted) return;
  globalForRecovery.workBoardRecoveryStarted = true;
  await cleanupTerminalLaunchFiles();

  const interrupted = await prisma.run.findMany({
    where: { status: "RUNNING", trigger: { notIn: [...TERMINAL_RUN_TRIGGERS] } },
    include: { work: true },
  });
  for (const run of interrupted) {
    const errorMessage = "Work Board restarted while this run was active";
    const finishedAt = new Date();
    if (run.taskId) {
      await finalizeAutomationRun(run.id, "FAILED", null, errorMessage);
      continue;
    } else if (run.work) {
      const paths = getWorkRunArtifactPaths(run.work.directoryPath, run.id);
      const executionPath = run.executionPath ?? run.work.directoryPath;
      let snapshot = await readWorkRunSnapshot(paths.snapshot).catch(() => null);
      if (!snapshot) {
        snapshot = {
          schemaVersion: 1,
          runId: run.id,
          workId: run.work.id,
          workName: run.work.name,
          promptFileName: run.work.promptFileName,
          prompt: run.promptSnapshot ?? run.work.promptCache,
          promptHash: hashWorkContent(run.promptSnapshot ?? run.work.promptCache),
          engine: run.engine ?? run.work.defaultEngine,
          sessionId: run.copilotSessionId ?? "unknown",
          executionPath,
          concurrencyMode: run.concurrencyMode ?? "DIRECT",
          trigger: run.trigger,
          resumedFromRunId: run.resumedFromRunId,
          status: "RUNNING",
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: null,
          exitCode: null,
          errorMessage: null,
          gitBeforeTree: null,
          gitAfterTree: null,
          agent: run.agent,
          model: run.model,
          fallbackModel: run.fallbackModel,
          contextTier: run.contextTier,
          reasoningEffort: run.reasoningEffort,
          permissionMode: run.permissionMode,
          outputFormat: run.outputFormat,
          timeoutSeconds: run.timeoutSeconds,
        } satisfies WorkRunSnapshot;
        await prepareWorkRunArtifacts(run.work.directoryPath, run.id, snapshot).catch(() => {});
      }
      const sourceDiff = await captureRunSourceDiff({
        executionPath,
        workDirectory: run.work.directoryPath,
        runId: run.id,
        beforeGitTree: snapshot.gitBeforeTree,
      }).catch(() => ({ afterGitTree: null, diff: "" }));
      const afterTree = sourceDiff.afterGitTree;
      const diff = sourceDiff.diff;
      await finalizeWorkRunArtifacts({
        paths,
        snapshot: {
          ...snapshot,
          status: "FAILED",
          finishedAt: finishedAt.toISOString(),
          errorMessage,
          gitAfterTree: afterTree,
        },
        finalOutput: null,
        diff,
      }).catch(() => {});
      await prisma.work.update({ where: { id: run.work.id }, data: { status: "ACTIVE" } });
    }
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "FAILED", errorMessage, finishedAt },
    });
  }

  const pending = await prisma.run.findMany({
    where: { status: "PENDING" },
    include: { task: true, work: true },
    orderBy: { createdAt: "asc" },
  });
  for (const run of pending) {
    if (run.task) {
      if (run.task.archivedAt) {
        await prisma.run.update({ where: { id: run.id }, data: { status: "CANCELLED" } });
        if (run.workId) await finalizeCancelledWorkRun(run.id, "Automation was archived.");
        else await finalizeAutomationRun(run.id, "CANCELLED", "Automation was archived.");
      } else {
        jobQueue.enqueue(
          run.task.repoId,
          () => executeRun(run.id),
          run.task.waitForPreviousRuns
        );
      }
    } else if (run.work) {
      if (run.work.status === "ARCHIVED") {
        await prisma.run.update({ where: { id: run.id }, data: { status: "CANCELLED" } });
        await finalizeCancelledWorkRun(run.id, "Work was archived before this run started.");
      } else {
        jobQueue.enqueue(getWorkRunQueueKey(run), () => executeWorkRun(run.id));
      }
    } else {
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          errorMessage: "Run has no Work or Automation owner",
          finishedAt: new Date(),
        },
      });
    }
  }
}

async function cleanupTerminalLaunchFiles(): Promise<void> {
  const directory = path.join(process.cwd(), "data", "terminal-launches");
  const files = await readdir(directory).catch(() => []);
  const ids = files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  if (ids.length === 0) return;
  const launches = await prisma.terminalLaunch.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, expiresAt: true },
  });
  const byId = new Map(launches.map((launch) => [launch.id, launch]));

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const launch = byId.get(file.slice(0, -5));
    if (!launch || launch.status === "COMPLETED") {
      await rm(path.join(directory, file), { force: true }).catch(() => {});
    }
  }
}