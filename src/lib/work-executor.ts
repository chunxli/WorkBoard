import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import {
  extractFinalCopilotOutput,
  startCopilotRun,
  type RunOutputFormat,
} from "@/lib/copilot-runner";
import { startCopilotSdkRun } from "@/lib/copilot-sdk-runner";
import {
  getHeadCommit,
} from "@/lib/git-safety";
import {
  finalizeWorkRunArtifacts,
  getWorkRunArtifactPaths,
  prepareWorkRunArtifacts,
  readWorkRunSnapshot,
  serializeRunFinalization,
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import { detectSkillInvocation } from "@/lib/skill-events";
import { appendWorkFollowUp, hashWorkContent } from "@/lib/work-files";
import {
  captureRunSourceBaseline,
  captureRunSourceDiff,
  inheritRunSourceBaseline,
} from "@/lib/run-source-snapshot";
import { repairLegacyCopilotSessionEvents } from "@/lib/copilot-session-compat";
import {
  readCopilotSessionInsights,
  serializeCopilotTokenUsage,
  subtractCopilotTokenUsage,
} from "@/lib/copilot-session-insights";

export async function createPendingWorkRun(options: {
  workId: string;
  engine: "CLI" | "SDK";
  executionPath: string;
  prompt: string;
  concurrencyMode: string;
  trigger?: "WORK" | "EXPERIMENT";
  experimentVariantId?: string;
}) {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const work = await prisma.work.findUniqueOrThrow({ where: { id: options.workId } });
  const outputDir = getWorkRunArtifactPaths(work.directoryPath, runId).outputDirectory;
  return prisma.run.create({
    data: {
      id: runId,
      workId: work.id,
      status: "PENDING",
      trigger: options.trigger ?? "WORK",
      engine: options.engine,
      executionPath: options.executionPath,
      promptSnapshot: options.prompt,
      outputFormat: work.outputFormat,
      timeoutSeconds: work.timeoutSeconds,
      agent: work.agent,
      model: work.model,
      fallbackModel: work.fallbackModel,
      contextTier: work.contextTier,
      reasoningEffort: work.reasoningEffort,
      permissionMode: work.permissionMode,
      outputDir,
      copilotSessionId: sessionId,
      concurrencyMode: options.concurrencyMode,
      experimentVariantId: options.experimentVariantId,
    },
  });
}

export async function createPendingFollowUpRun(options: {
  workId: string;
  prompt: string;
  parentRunId?: string | null;
}) {
  const runId = randomUUID();
  const work = await prisma.work.findUniqueOrThrow({ where: { id: options.workId } });
  const parent = options.parentRunId
    ? await prisma.run.findFirstOrThrow({
        where: {
          id: options.parentRunId,
          workId: work.id,
          experimentVariantId: null,
        },
      })
    : null;
  const sessionId = parent?.copilotSessionId ?? randomUUID();
  const executionPath = parent?.executionPath ?? work.directoryPath;
  const outputDir = getWorkRunArtifactPaths(work.directoryPath, runId).outputDirectory;
  const settings = resolveFollowUpExecutionSettings(work, parent);

  return prisma.run.create({
    data: {
      id: runId,
      workId: work.id,
      status: "PENDING",
      trigger: "FOLLOW_UP",
      engine: settings.engine,
      executionPath,
      promptSnapshot: options.prompt,
      outputFormat: settings.outputFormat,
      timeoutSeconds: settings.timeoutSeconds,
      agent: settings.agent,
      model: settings.model,
      fallbackModel: settings.fallbackModel,
      contextTier: settings.contextTier,
      reasoningEffort: settings.reasoningEffort,
      permissionMode: settings.permissionMode,
      outputDir,
      copilotSessionId: sessionId,
      concurrencyMode: parent ? "FOLLOW_UP_RESUME" : "FOLLOW_UP_NEW_SESSION",
      resumedFromRunId: parent?.id ?? null,
    },
  });
}

interface FollowUpSettingsSource {
  defaultEngine?: "CLI" | "SDK";
  engine?: "CLI" | "SDK" | null;
  agent: string | null;
  model: string | null;
  fallbackModel: string | null;
  contextTier: string | null;
  reasoningEffort: string | null;
  permissionMode: string | null;
  outputFormat: string | null;
  timeoutSeconds: number | null;
}

export function resolveFollowUpExecutionSettings(
  work: FollowUpSettingsSource,
  parent: FollowUpSettingsSource | null
) {
  const source = parent ?? work;
  return {
    engine: parent?.engine ?? work.defaultEngine ?? "CLI",
    agent: source.agent,
    model: source.model,
    fallbackModel: source.fallbackModel,
    contextTier: source.contextTier,
    reasoningEffort: source.reasoningEffort,
    permissionMode: source.permissionMode ?? work.permissionMode ?? "default",
    outputFormat: source.outputFormat ?? work.outputFormat ?? "text",
    timeoutSeconds: source.timeoutSeconds,
  };
}

export function getWorkRunQueueKey(run: {
  id: string;
  trigger: string;
  copilotSessionId: string | null;
}): string {
  return run.trigger === "FOLLOW_UP" && run.copilotSessionId
    ? `session:${run.copilotSessionId}`
    : run.id;
}

export function resolveWorkCliOutputOptions(outputFormat: RunOutputFormat) {
  return {
    outputFormat,
    maxIncompleteContinuations: 3,
  };
}

export async function ensureFollowUpPrompt(
  work: { id: string; directoryPath: string; promptFileName: string },
  run: { id: string; createdAt: Date; promptSnapshot: string | null }
): Promise<void> {
  await appendWorkFollowUp(work, run.promptSnapshot ?? "", {
    createdAt: run.createdAt,
    followUpId: run.id,
    afterWrite: async (updatedPrompt) => {
      await prisma.work.update({
        where: { id: work.id },
        data: { promptCache: updatedPrompt.content, promptHash: updatedPrompt.hash },
      });
    },
  });
}

export async function executeWorkRun(runId: string): Promise<void> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { work: true, experimentVariant: { include: { experiment: true } } },
  });
  const work = run.work;
  if (!work) throw new Error(`Work run ${run.id} has no Work`);

  const executionPath = run.executionPath ?? work.directoryPath;
  const prompt = run.promptSnapshot ?? work.promptCache;
  const engine = run.engine ?? work.defaultEngine;
  const outputFormat = run.outputFormat === "json" ? "json" : "text";
  const timeoutSeconds = run.timeoutSeconds;
  const sessionId = run.copilotSessionId ?? randomUUID();
  const artifactPaths = getWorkRunArtifactPaths(work.directoryPath, run.id);
  let beforeTree: string | null = null;
  let afterTree: string | null = null;
  let baseCommit: string | null = null;
  let finalCommit: string | null = null;
  let startedAt: Date | null = null;

  const snapshot = (overrides: Partial<WorkRunSnapshot> = {}): WorkRunSnapshot => ({
    schemaVersion: 1,
    runId: run.id,
    workId: work.id,
    workName: work.name,
    promptFileName: work.promptFileName,
    prompt,
    promptHash: hashWorkContent(prompt),
    engine,
    sessionId,
    executionPath,
    concurrencyMode: run.concurrencyMode ?? "DIRECT",
    trigger: run.trigger,
    resumedFromRunId: run.resumedFromRunId,
    status: run.status,
    startedAt: startedAt?.toISOString() ?? null,
    finishedAt: null,
    exitCode: null,
    errorMessage: null,
    gitBeforeTree: beforeTree,
    gitAfterTree: afterTree,
    experimentVariantId: run.experimentVariantId,
    skillName: run.experimentVariant?.skillName,
    skillHash: run.experimentVariant?.skillHash,
    skillInvocationMode: run.experimentVariant?.experiment.invocationMode,
    agent: run.agent,
    model: run.model,
    fallbackModel: run.fallbackModel,
    contextTier: run.contextTier,
    reasoningEffort: run.reasoningEffort,
    permissionMode: run.permissionMode,
    outputFormat,
    timeoutSeconds,
    ...overrides,
  });

  try {
    await prepareWorkRunArtifacts(work.directoryPath, run.id, snapshot());
    if (run.trigger === "FOLLOW_UP") {
      await ensureFollowUpPrompt(work, run);
    }
    const pendingRun = await prisma.run.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    if (pendingRun?.status !== "PENDING") {
      if (pendingRun?.status === "CANCELLED") {
        await finalizeCancelledWorkRun(run.id, "Run was cancelled before it started.");
      }
      return;
    }

    if (run.resumedFromRunId) {
      const parentPaths = getWorkRunArtifactPaths(work.directoryPath, run.resumedFromRunId);
      const parentSnapshot = await readWorkRunSnapshot(parentPaths.snapshot).catch(() => null);
      beforeTree = parentSnapshot
        ? await inheritRunSourceBaseline({
            sourceWorkDirectory: work.directoryPath,
            sourceRunId: run.resumedFromRunId,
            sourceGitTree: parentSnapshot.gitAfterTree,
            targetWorkDirectory: work.directoryPath,
            targetRunId: run.id,
          }).catch(() => captureRunSourceBaseline(executionPath, work.directoryPath, run.id))
        : await captureRunSourceBaseline(executionPath, work.directoryPath, run.id);
      await repairLegacyCopilotSessionEvents(sessionId);
    } else {
      beforeTree = await captureRunSourceBaseline(executionPath, work.directoryPath, run.id);
    }
    baseCommit = await getHeadCommit(executionPath).catch(() => null);
    startedAt = new Date();
    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: "PENDING" },
      data: {
        status: "RUNNING",
        startedAt,
        baseCommit,
        hostname: hostname(),
        logPath: artifactPaths.stdout,
        copilotSessionId: sessionId,
      },
    });
    if (claimed.count === 0) {
      const current = await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
      if (current?.status === "CANCELLED") {
        await finalizeCancelledWorkRun(run.id, "Run was cancelled before it started.");
        return;
      }
      throw new Error(`Run ${run.id} could not be claimed from PENDING state`);
    }
    if (run.experimentVariantId) {
      await prisma.experimentVariant.update({
        where: { id: run.experimentVariantId },
        data: { status: "RUNNING" },
      });
    }

    const onSpawn = ({
      pid,
      command,
      model,
    }: {
      pid: number | null;
      command: string;
      model: string | null;
    }) => {
      void prisma.run.update({ where: { id: run.id }, data: { pid, command, model } }).catch(() => {});
    };

    const currentStatus = await prisma.run.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    if (currentStatus?.status === "CANCELLED") {
      await finalizeCancelledWorkRun(run.id);
      return;
    }

    const sdkUsageBaseline = engine === "SDK"
      ? await readCopilotSessionInsights(sessionId).catch(() => null)
      : null;

    const result =
      engine === "SDK"
        ? await startCopilotSdkRun({
            runId: run.id,
            sessionId,
            workPath: executionPath,
            prompt,
            resumeSession: Boolean(run.resumedFromRunId),
            model: run.model,
            contextTier: run.contextTier,
            reasoningEffort: run.reasoningEffort,
            timeoutSeconds,
            stdoutLogPath: artifactPaths.stdout,
            stderrLogPath: artifactPaths.stderr,
            onSpawn,
          })
        : await startCopilotRun({
            runId: run.id,
            sessionId,
            repoPath: executionPath,
            prompt,
            resumeSession: Boolean(run.resumedFromRunId),
            agent: run.agent,
            model: run.model,
            fallbackModel: run.fallbackModel,
            contextTier: run.contextTier,
            reasoningEffort: run.reasoningEffort,
            permissionMode: run.permissionMode === "full" ? "full" : "default",
            ...resolveWorkCliOutputOptions(outputFormat),
            timeoutSeconds,
            stdoutLogPath: artifactPaths.stdout,
            stderrLogPath: artifactPaths.stderr,
            onSpawn,
          });

    const usage = "usage" in result
      ? result.usage
      : subtractCopilotTokenUsage(
          (await readCopilotSessionInsights(sessionId).catch(() => null))?.usage ?? null,
          sdkUsageBaseline?.usage ?? null
        );
    const usageData = serializeCopilotTokenUsage(usage);

    const sourceDiff = await captureRunSourceDiff({
      executionPath,
      workDirectory: work.directoryPath,
      runId: run.id,
      beforeGitTree: beforeTree,
    });
    afterTree = sourceDiff.afterGitTree;
    finalCommit = await getHeadCommit(executionPath).catch(() => null);
    const diff = sourceDiff.diff;
    const stdout = await readFile(artifactPaths.stdout, "utf8").catch(() => "");
    const skillInvoked = detectSkillInvocation(stdout, run.experimentVariant?.skillName ?? null);
    const incomplete = "incomplete" in result && result.incomplete;
    const finalOutput = incomplete
      ? null
      : result.finalOutput ?? extractFinalCopilotOutput(stdout);
    const errorMessage = "incompleteReason" in result ? result.incompleteReason : null;
    const status = result.cancelled
      ? "CANCELLED"
      : result.timedOut
        ? "TIMED_OUT"
        : incomplete
          ? "FAILED"
          : result.exitCode === 0
            ? "SUCCESS"
            : "FAILED";
    const finishedAt = new Date();

    await finalizeWorkRunArtifacts({
      paths: artifactPaths,
      snapshot: snapshot({
        status,
        finishedAt: finishedAt.toISOString(),
        exitCode: result.exitCode,
        errorMessage,
        gitBeforeTree: beforeTree,
        gitAfterTree: afterTree,
        ...usageData,
      }),
      finalOutput,
      diff,
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status,
        finalCommit,
        finalOutput,
        errorMessage,
        exitCode: result.exitCode,
        finishedAt,
        cpuTimeMs: result.cpuTimeMs,
        peakMemoryMb: result.peakMemoryMb,
        ...usageData,
      },
    });
    if (run.experimentVariantId) {
      await prisma.experimentVariant.update({
        where: { id: run.experimentVariantId },
        data: {
          status: status === "SUCCESS" ? "SUCCESS" : status === "CANCELLED" ? "CANCELLED" : "FAILED",
          skillInvoked,
          errorMessage: status === "SUCCESS" ? null : `Run finished with status ${status}`,
        },
      });
      await refreshExperimentStatus(run.experimentVariant!.experimentId);
    }

    const otherLiveRuns = await prisma.run.count({
      where: { workId: work.id, id: { not: run.id }, status: { in: ["PENDING", "RUNNING"] } },
    });
    if (otherLiveRuns === 0) {
      await prisma.work.update({
        where: { id: work.id },
        data: { status: status === "SUCCESS" ? "REVIEW" : "ACTIVE" },
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    const sourceDiff = await captureRunSourceDiff({
      executionPath,
      workDirectory: work.directoryPath,
      runId: run.id,
      beforeGitTree: beforeTree,
    }).catch(() => ({ afterGitTree: null, diff: "" }));
    afterTree = sourceDiff.afterGitTree;
    finalCommit = await getHeadCommit(executionPath).catch(() => null);
    const diff = sourceDiff.diff;
    await finalizeWorkRunArtifacts({
      paths: artifactPaths,
      snapshot: snapshot({
        status: "FAILED",
        finishedAt: finishedAt.toISOString(),
        errorMessage,
        gitBeforeTree: beforeTree,
        gitAfterTree: afterTree,
      }),
      finalOutput: null,
      diff,
    }).catch(() => {});
    await prisma.$transaction([
      prisma.run.update({
        where: { id: run.id },
        data: { status: "FAILED", finalCommit, errorMessage, finishedAt },
      }),
      prisma.work.update({ where: { id: work.id }, data: { status: "ACTIVE" } }),
    ]);
    if (run.experimentVariantId) {
      await prisma.experimentVariant.update({
        where: { id: run.experimentVariantId },
        data: { status: "FAILED", errorMessage },
      });
      await refreshExperimentStatus(run.experimentVariant!.experimentId);
    }
  }
}

export async function refreshExperimentStatus(experimentId: string): Promise<void> {
  const variants = await prisma.experimentVariant.findMany({
    where: { experimentId },
    select: { status: true },
  });
  const active = variants.some((variant) =>
    ["COPYING", "READY", "RUNNING"].includes(variant.status)
  );
  if (active) {
    await prisma.experiment.updateMany({
      where: { id: experimentId, status: { in: ["PROVISIONING", "RUNNING"] } },
      data: { status: "RUNNING" },
    });
    return;
  }
  await prisma.experiment.updateMany({
    where: { id: experimentId, status: { in: ["PROVISIONING", "RUNNING"] } },
    data: { status: "COMPLETED", finishedAt: new Date() },
  });
}

export async function finalizeCancelledWorkRun(
  runId: string,
  message = "Run was cancelled."
): Promise<void> {
  await serializeRunFinalization(runId, () => finalizeCancelledWorkRunUnlocked(runId, message));
}

async function finalizeCancelledWorkRunUnlocked(
  runId: string,
  message: string
): Promise<void> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { work: true, experimentVariant: true },
  });
  if (run.finishedAt && run.outputDir) return;
  if (!run.work) {
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
    return;
  }

  const work = run.work;
  const executionPath = run.executionPath ?? work.directoryPath;
  const paths = getWorkRunArtifactPaths(work.directoryPath, run.id);
  let snapshot = await readWorkRunSnapshot(paths.snapshot).catch(() => null);
  if (!snapshot) {
    snapshot = {
      schemaVersion: 1,
      runId: run.id,
      workId: work.id,
      workName: work.name,
      promptFileName: work.promptFileName,
      prompt: run.promptSnapshot ?? work.promptCache,
      promptHash: hashWorkContent(run.promptSnapshot ?? work.promptCache),
      engine: run.engine ?? work.defaultEngine,
      sessionId: run.copilotSessionId ?? "unknown",
      executionPath,
      concurrencyMode: run.concurrencyMode ?? "DIRECT",
      trigger: run.trigger,
      resumedFromRunId: run.resumedFromRunId,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: null,
      exitCode: null,
      errorMessage: null,
      gitBeforeTree: null,
      gitAfterTree: null,
      experimentVariantId: run.experimentVariantId,
      skillName: run.experimentVariant?.skillName,
      skillHash: run.experimentVariant?.skillHash,
      agent: run.agent,
      model: run.model,
      fallbackModel: run.fallbackModel,
      contextTier: run.contextTier,
      reasoningEffort: run.reasoningEffort,
      permissionMode: run.permissionMode,
      outputFormat: run.outputFormat,
      timeoutSeconds: run.timeoutSeconds,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
      reasoningTokens: run.reasoningTokens,
      modelsUsed: run.modelsUsed,
    } satisfies WorkRunSnapshot;
    await prepareWorkRunArtifacts(work.directoryPath, run.id, snapshot);
  }
  const sourceDiff = await captureRunSourceDiff({
    executionPath,
    workDirectory: work.directoryPath,
    runId: run.id,
    beforeGitTree: snapshot.gitBeforeTree,
  }).catch(() => ({ afterGitTree: null, diff: "" }));
  const afterTree = sourceDiff.afterGitTree;
  const diff = sourceDiff.diff;
  const finishedAt = new Date();
  await finalizeWorkRunArtifacts({
    paths,
    snapshot: {
      ...snapshot,
      status: "CANCELLED",
      finishedAt: finishedAt.toISOString(),
      gitAfterTree: afterTree,
    },
    finalOutput: message,
    diff,
  });

  await prisma.run.update({
    where: { id: run.id },
    data: { status: "CANCELLED", finishedAt, finalOutput: message },
  });
  if (run.experimentVariantId) {
    await prisma.experimentVariant.update({
      where: { id: run.experimentVariantId },
      data: { status: "CANCELLED", errorMessage: null },
    });
    await refreshExperimentStatus(run.experimentVariant!.experimentId);
  }
  const otherLiveRuns = await prisma.run.count({
    where: { workId: work.id, id: { not: run.id }, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (otherLiveRuns === 0) {
    await prisma.work.update({ where: { id: work.id }, data: { status: "ACTIVE" } });
  }
}