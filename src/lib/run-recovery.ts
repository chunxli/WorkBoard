import type { Prisma } from "@/generated/prisma/client";
import { finalizeCaseIqSessionHome } from "@/lib/caseiq-integration";
import {
  CASEIQ_RECOVERY_RESERVED, inspectInterruptedCaseIqRun, interruptedCaseIqRunIds, readCaseIqRunCompletion,
  releaseInterruptedCaseIqRun, trackInterruptedCaseIqRun,
} from "@/lib/caseiq-run-lifecycle";
import { isNativeCopilotRunActive } from "@/lib/copilot-runner";
import { prisma } from "@/lib/prisma";
import { JobQueue, jobQueue } from "@/lib/job-queue";
import { executeRun, finalizeAutomationRun } from "@/lib/task-executor";
import {
  cancelPendingCaseIqWorkRun,
  executeWorkRun,
  finalizeCancelledWorkRun,
  settleCaseIqWorkRun,
} from "@/lib/work-executor";
import { getWorkRunQueueKey, orderPendingWorkRuns } from "@/lib/work-run-queue";
import {
  finalizeWorkRunArtifacts,
  getWorkRunArtifactPaths,
  readVerifiedRunArtifact,
  readWorkRunSnapshot,
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import { hashWorkContent } from "@/lib/work-files";
import { captureRunSourceDiff } from "@/lib/run-source-snapshot";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { TERMINAL_RUN_TRIGGERS } from "@/lib/terminal-run";
import { resolveRunCompletionArtifactPaths, verifyPairedRunDirectory } from "@/lib/work-pair-directories";
import { isCaseIqWebRun } from "@/lib/runtime-provider";
import { z } from "zod";

const globalForRecovery = globalThis as typeof globalThis & {
  workBoardRecoveryStarted?: boolean;
  caseIqRecoveryTimer?: NodeJS.Timeout;
  caseIqRecoveryQueue?: JobQueue;
  caseIqRecoveryChecks?: Map<string, Promise<void>>;
};
const caseIqRecoveryQueue = globalForRecovery.caseIqRecoveryQueue ??= new JobQueue(2);
const caseIqRecoveryChecks = globalForRecovery.caseIqRecoveryChecks ??= new Map<string, Promise<void>>();
const workRelation = { work: { include: { sessionPair: true } } } satisfies Prisma.RunInclude;
type InterruptedRun = Prisma.RunGetPayload<{ include: typeof workRelation }>;
type InterruptedRunStatus = "FAILED" | "CANCELLED" | "TIMED_OUT";
const caseIqTerminalSnapshot = z.object({
  schemaVersion: z.literal(1), runId: z.string(), workId: z.string(), sessionId: z.string(), executionPath: z.string(),
  engine: z.literal("CASEIQ"), providerId: z.literal("caseiq"),
  status: z.enum(["SUCCESS", "FAILED", "CANCELLED", "TIMED_OUT"]),
  finishedAt: z.iso.datetime(), exitCode: z.number().int().nullable(), errorMessage: z.string().nullable(),
  model: z.string().nullable(), inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(), cacheWriteTokens: z.number().int().nullable(),
  reasoningTokens: z.number().int().nullable(), modelsUsed: z.string().nullable(),
});

export async function recoverRuns(): Promise<void> {
  if (globalForRecovery.workBoardRecoveryStarted) return;
  globalForRecovery.workBoardRecoveryStarted = true;
  await cleanupTerminalLaunchFiles();

  const interrupted = await prisma.run.findMany({
    where: { status: "RUNNING", trigger: { notIn: [...TERMINAL_RUN_TRIGGERS] } },
    include: workRelation,
  });
  for (const run of interrupted) {
    if (isCaseIqWebRun(run)) {
      // Restore the hold before enqueueing pending work; process checks run in the background.
      trackInterruptedCaseIqRun(run);
    } else {
      await finalizeInterruptedRun(run, "Work Board restarted while this run was active");
    }
  }

  const pending = await prisma.run.findMany({
    where: { status: "PENDING" },
    include: { task: true, work: true },
    orderBy: { createdAt: "asc" },
  });
  for (const run of orderPendingWorkRuns(pending)) {
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
        const message = "Work was archived before this run started.";
        if (isCaseIqWebRun(run)) {
          await cancelPendingCaseIqWorkRun(run.id, message);
        } else {
          await prisma.run.update({ where: { id: run.id }, data: { status: "CANCELLED" } });
          await finalizeCancelledWorkRun(run.id, message);
        }
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

async function finalizeInterruptedRun(run: InterruptedRun, errorMessage: string, {
  status = "FAILED", beforeLaunch = false,
}: { status?: InterruptedRunStatus; beforeLaunch?: boolean } = {}) {
  const finishedAt = new Date();
  if (run.taskId) {
    await finalizeAutomationRun(run.id, status, null, errorMessage);
    return;
  }
  const caseIq = isCaseIqWebRun(run);
  const saveOutcome = async (message: string) => {
    const data = { status, errorMessage: message, finishedAt };
    if (caseIq) await settleCaseIqWorkRun(run, data);
    else await prisma.run.update({ where: { id: run.id }, data });
  };
  if (run.work) {
    let artifactRoot: string;
    try { artifactRoot = await verifyPairedRunDirectory(run.work, run); }
    catch (error) {
      console.error("[Work Board] Could not recover paired Run artifacts.", error);
      await saveOutcome(`${errorMessage} Its original output directory could not be verified.`);
      return;
    }
    const paths = getWorkRunArtifactPaths(artifactRoot, run.id);
    const executionPath = run.executionPath ?? run.work.directoryPath;
    let snapshot = await readWorkRunSnapshot(paths.snapshot).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.warn("[Work Board] Could not read the interrupted Run snapshot.", run.id, error instanceof Error ? error.name : error);
      }
      return null;
    });
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
        ...(run.providerId ? { providerId: run.providerId } : {}),
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
    }
    try {
      // Unlike initialization for a brand-new Run, recovery must not truncate existing logs.
      await mkdir(/* turbopackIgnore: true */ paths.outputDirectory, { recursive: true });
      const sourceDiff = beforeLaunch ? null : await captureRunSourceDiff({
        executionPath, workDirectory: artifactRoot, runId: run.id, beforeGitTree: snapshot.gitBeforeTree,
      }).catch((error: unknown) => {
        console.warn("[Work Board] Could not recover the workspace diff.", run.id, error instanceof Error ? error.name : error);
        return null;
      });
      const afterGitTree = sourceDiff?.afterGitTree ?? null;
      await finalizeWorkRunArtifacts({
        paths,
        snapshot: {
          ...snapshot, status, finishedAt: finishedAt.toISOString(), errorMessage, gitAfterTree: afterGitTree,
          ...(caseIq ? { sourceAfterCaptured: sourceDiff !== null && (!snapshot.gitBeforeTree || afterGitTree !== null) } : {}),
        },
        finalOutput: null,
        diff: sourceDiff?.diff ?? "",
      });
    } catch (error) {
      console.warn("[Work Board] Could not write recovery artifacts.", run.id, error instanceof Error ? error.name : error);
    }
    if (!caseIq) await prisma.work.update({ where: { id: run.work.id }, data: { status: "ACTIVE" } });
  }
  await saveOutcome(errorMessage);
}

async function restoreCaseIqCompletion(run: InterruptedRun, fallbackStatus: InterruptedRunStatus): Promise<boolean> {
  const work = run.work;
  if (!work || !run.executionPath) return false;
  const { id, executionPath } = run;
  const recover = async () => {
    const receipt = await readCaseIqRunCompletion({ ...run, workId: work.id });
    if (!receipt) return null;
    const paths = await resolveRunCompletionArtifactPaths(work, run);
    const [snapshot, result] = await Promise.all([
      readVerifiedRunArtifact(paths.snapshot, receipt.artifacts.snapshot),
      readVerifiedRunArtifact(paths.result, receipt.artifacts.result),
    ]);
    const { schemaVersion, runId, workId, sessionId, executionPath: savedPath, engine, providerId, finishedAt, ...outcome } =
      caseIqTerminalSnapshot.parse(JSON.parse(snapshot));
    if (schemaVersion !== 1 || engine !== run.engine || providerId !== run.providerId || runId !== id ||
        workId !== work.id || sessionId !== run.copilotSessionId || !path.isAbsolute(savedPath) ||
        path.relative(savedPath, executionPath) !== "") {
      throw new Error("CaseIQ completion artifacts do not belong to this Run.");
    }
    return {
      data: { ...outcome, finishedAt: new Date(finishedAt), finalCommit: receipt.finalCommit,
        finalOutput: receipt.hasOutput ? result.trimEnd() : null },
      skillInvoked: receipt.skillInvoked,
    };
  };
  const completion = await recover().catch((error: unknown) => {
    console.warn("[CaseIQ] Saved completion could not be verified; preserving the existing artifacts.", id, error instanceof Error ? error.name : error);
    return {
      data: {
        status: fallbackStatus,
        finishedAt: new Date(),
        errorMessage: "CaseIQ stopped, but its saved completion could not be verified. Existing files were preserved and no Prompt was replayed.",
      },
      skillInvoked: undefined,
    };
  });
  if (!completion) return false;
  await settleCaseIqWorkRun(run, completion.data, { skillInvoked: completion.skillInvoked });
  return true;
}

async function reconcileInterruptedCaseIqRun(run: InterruptedRun) {
  if (isNativeCopilotRunActive(run.id)) return;
  try {
    const observation = await inspectInterruptedCaseIqRun(run);
    if (observation.stopped) {
      for (const requestFile of observation.completedRequests) {
        try { await finalizeCaseIqSessionHome(run, requestFile); }
        catch (error) { console.error("[CaseIQ] Recovered session history could not be rebound.", error); }
      }
      const status = observation.timedOut ? "TIMED_OUT" : observation.cancelled ? "CANCELLED" : "FAILED";
      const message = status === "TIMED_OUT" ? "CaseIQ timed out and its exit was confirmed after interruption. No Prompt was replayed."
        : observation.beforeLaunch
          ? status === "CANCELLED" ? "CaseIQ was cancelled before launch. No Prompt was sent."
            : "Work Board was interrupted during CaseIQ preparation. No Prompt was sent."
          : status === "CANCELLED" ? "CaseIQ cancellation confirmed after interruption. No Prompt was replayed."
            : "CaseIQ stopped after interruption. Inspect the original output; no Prompt was replayed.";
      if (!await restoreCaseIqCompletion(run, status)) {
        await finalizeInterruptedRun(run, message, { status, beforeLaunch: observation.beforeLaunch });
      }
      releaseInterruptedCaseIqRun(run.id);
      return;
    }
  } catch (error) {
    if (run.errorMessage !== CASEIQ_RECOVERY_RESERVED) {
      console.error("[CaseIQ] Run recovery could not confirm exit.", run.id, error instanceof Error ? error.name : error);
    }
  }
  if (run.errorMessage !== CASEIQ_RECOVERY_RESERVED) {
    await prisma.run.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: { errorMessage: CASEIQ_RECOVERY_RESERVED },
    });
  }
}

function scheduleCaseIqRecoveryCheck(run: Pick<InterruptedRun, "id" | "copilotSessionId">): Promise<void> {
  const { id } = run;
  const pending = caseIqRecoveryChecks.get(id);
  if (pending) return pending;
  const key = getWorkRunQueueKey(run);
  const { promise, resolve } = Promise.withResolvers<void>();
  caseIqRecoveryChecks.set(id, promise);
  caseIqRecoveryQueue.enqueue(key, async () => {
    try {
      const current = await prisma.run.findUnique({ where: { id }, include: workRelation });
      if (!current || current.status !== "RUNNING") {
        releaseInterruptedCaseIqRun(id);
        return;
      }
      if (!isCaseIqWebRun(current) || getWorkRunQueueKey(current) !== key) {
        throw new Error("CaseIQ Run ownership changed while its recovery check was queued.");
      }
      await reconcileInterruptedCaseIqRun(current);
    } catch (error) {
      console.error("[CaseIQ] Run recovery check failed.", id, error);
    } finally {
      caseIqRecoveryChecks.delete(id);
      resolve();
    }
  });
  return promise;
}

async function scheduleInterruptedCaseIqRunChecks(): Promise<Promise<void>[]> {
  const ids = interruptedCaseIqRunIds().filter((id) => !caseIqRecoveryChecks.has(id));
  if (!ids.length) return [];
  const runs = await prisma.run.findMany({
    where: { id: { in: ids }, status: "RUNNING" },
    select: { id: true, copilotSessionId: true },
  });
  const outstanding = new Set(runs.map(({ id }) => id));
  for (const id of ids) if (!outstanding.has(id)) releaseInterruptedCaseIqRun(id);
  return runs.map(scheduleCaseIqRecoveryCheck);
}

export async function reconcileInterruptedCaseIqRuns(): Promise<void> {
  const checks = [...caseIqRecoveryChecks.values(), ...await scheduleInterruptedCaseIqRunChecks()];
  await Promise.all(checks);
}

export function startCaseIqRunRecovery(): void {
  if (globalForRecovery.caseIqRecoveryTimer) return;
  let dispatching = false;
  const tick = () => {
    if (dispatching) return;
    dispatching = true;
    // Future ticks can dispatch other sessions while an earlier check is still running.
    void scheduleInterruptedCaseIqRunChecks()
      .catch((error) => console.error("[CaseIQ] Run recovery scan failed.", error))
      .finally(() => { dispatching = false; });
  };
  globalForRecovery.caseIqRecoveryTimer = setInterval(tick, 5_000);
  globalForRecovery.caseIqRecoveryTimer.unref();
  tick();
}

async function cleanupTerminalLaunchFiles(): Promise<void> {
  const directory = path.join(process.cwd(), "data", "terminal-launches");
  const files = await readdir(directory).catch(() => []);
  const ids = files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  if (ids.length === 0) return;
  const launches = await prisma.terminalLaunch.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
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