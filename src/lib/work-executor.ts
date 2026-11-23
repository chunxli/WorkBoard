import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import type { Prisma, Run } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { QUEUED_FOLLOW_UP_MODE } from "@/lib/work-run-queue";
import { isCaseIqWebRun, webFollowUpBlockedReason } from "@/lib/runtime-provider";
export { getWorkRunQueueKey } from "@/lib/work-run-queue";
import { attachmentPrompt, type WorkAttachment } from "@/lib/work-attachment-types";
import { parseWorkAttachments, readInitialWorkAttachments, runtimeWorkAttachments } from "@/lib/work-attachments";
import {
  extractFinalCopilotOutput,
  isNativeCopilotRunActive,
  registerNativeRunControl,
  startCopilotRun,
  type RunOutputFormat,
} from "@/lib/copilot-runner";
import { startCopilotSdkRun } from "@/lib/copilot-sdk-runner";
import { caseIqRunAlreadyFinalizing, CaseIqRunUnconfirmedError } from "@/lib/caseiq-errors";
import { startCaseIqRun } from "@/lib/caseiq-runner";
import {
  authorizeCaseIqRunLaunch, persistCaseIqPrelaunchCancellation, prepareCaseIqRunLaunch,
  sealCaseIqRunCompletion, trackInterruptedCaseIqRun,
} from "@/lib/caseiq-run-lifecycle";
import { ensurePrivateRuntimeDirectory } from "@/lib/caseiq-integration";
import { matchesPairedWorkspace, verifyPairedRunDirectory, writePairedWorkspaceInstructions, WorkPairError } from "@/lib/work-pair-directories";
import { readNativeSessionBindingSync } from "@/lib/native-session-bindings";
import { getManagedSessionController } from "@/lib/managed-session-controller";
import {
  getHeadCommit,
} from "@/lib/git-safety";
import {
  finalizeWorkRunArtifacts,
  getWorkRunArtifactPaths,
  prepareWorkRunArtifacts,
  readWorkRunSnapshot,
  serializeRunFinalization,
  writeRunSnapshot,
  type CaseIqRunVersion,
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import { detectSkillInvocation } from "@/lib/skill-events";
import { appendWorkFollowUp, hashWorkContent } from "@/lib/work-files";
import {
  captureRunSourceBaseline,
  captureRunSourceDiff,
  inheritRunSourceBaseline,
} from "@/lib/run-source-snapshot";
import { beginWorkRunPreparation } from "@/lib/work-run-preparation-state";
import { copilotSessionHasHistory, repairLegacyCopilotSessionEvents } from "@/lib/copilot-session-compat";
import {
  readCopilotSessionInsights,
  serializeCopilotTokenUsage,
  subtractCopilotTokenUsage,
} from "@/lib/copilot-session-insights";

export async function createPendingWorkRun(options: {
  workId: string;
  engine: "CLI" | "SDK" | "CASEIQ";
  executionPath: string;
  prompt: string;
  concurrencyMode: string;
  trigger?: "WORK" | "EXPERIMENT";
  experimentVariantId?: string;
}) {
  const runId = randomUUID();
  const sessionId = randomUUID();
  const work = await prisma.work.findUniqueOrThrow({ where: { id: options.workId } });
  const attachments = await readInitialWorkAttachments(work);
  const outputDir = getWorkRunArtifactPaths(work.directoryPath, runId).outputDirectory;
  return prisma.run.create({
    data: {
      id: runId,
      workId: work.id,
      status: "PENDING",
      trigger: options.trigger ?? "WORK",
      engine: options.engine,
      ...(options.engine === "CASEIQ" ? { providerId: "caseiq" } : {}),
      executionPath: options.executionPath,
      promptSnapshot: options.prompt,
      attachmentsJson: attachments.length ? JSON.stringify(attachments) : null,
      outputFormat: options.engine === "CASEIQ" ? "json" : work.outputFormat,
      timeoutSeconds: work.timeoutSeconds,
      agent: work.agent,
      model: work.model,
      fallbackModel: work.fallbackModel,
      contextTier: work.contextTier,
      reasoningEffort: work.reasoningEffort,
      permissionMode: options.engine === "CASEIQ" ? "default" : work.permissionMode,
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
  requestId?: string;
  attachments?: WorkAttachment[];
  queue?: boolean;
}) {
  const runId = options.requestId ?? randomUUID();
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
  const runtimeBlock = parent ? webFollowUpBlockedReason(parent) : null;
  if (runtimeBlock) throw new Error(runtimeBlock);
  if (options.queue && !parent) throw new Error("A queued follow-up requires a parent Run.");
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
      ...(settings.engine === "CASEIQ" ? { providerId: "caseiq" } : {}),
      executionPath,
      promptSnapshot: options.prompt,
      attachmentsJson: options.attachments?.length ? JSON.stringify(options.attachments) : null,
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
      concurrencyMode: options.queue ? QUEUED_FOLLOW_UP_MODE : parent ? "FOLLOW_UP_RESUME" : "FOLLOW_UP_NEW_SESSION",
      resumedFromRunId: parent?.id ?? null,
    },
  });
}

interface FollowUpSettingsSource {
  defaultEngine?: "CLI" | "SDK" | "CASEIQ";
  engine?: "CLI" | "SDK" | "CASEIQ" | null;
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
  const engine = parent?.engine ?? work.defaultEngine ?? "CLI";
  return {
    engine,
    agent: source.agent,
    model: source.model,
    fallbackModel: source.fallbackModel,
    contextTier: source.contextTier,
    reasoningEffort: source.reasoningEffort,
    permissionMode: engine === "CASEIQ" ? "default" : source.permissionMode ?? work.permissionMode ?? "default",
    outputFormat: engine === "CASEIQ" ? "json" : source.outputFormat ?? work.outputFormat ?? "text",
    timeoutSeconds: source.timeoutSeconds,
  };
}

export function resolveWorkCliOutputOptions(outputFormat: RunOutputFormat) {
  return {
    outputFormat,
    maxIncompleteContinuations: 3,
  };
}

export async function ensureFollowUpPrompt(
  work: { id: string; directoryPath: string; promptFileName: string },
  run: { id: string; createdAt: Date; promptSnapshot: string | null; attachmentsJson?: string | null }
): Promise<void> {
  const files = parseWorkAttachments(run.attachmentsJson);
  await appendWorkFollowUp(work, files.length ? attachmentPrompt(run.promptSnapshot ?? "", work.id, files) : run.promptSnapshot ?? "", {
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

export async function ensureSteeringPrompt(
  work: { id: string; directoryPath: string; promptFileName: string },
  message: { id: string; createdAt: Date; content: string; attachmentsJson?: string | null }
): Promise<void> {
  const files = parseWorkAttachments(message.attachmentsJson);
  await appendWorkFollowUp(work, files.length ? attachmentPrompt(message.content, work.id, files) : message.content, {
    createdAt: message.createdAt,
    followUpId: message.id,
    kind: "steering",
    afterWrite: async (updatedPrompt) => {
      await prisma.work.update({
        where: { id: work.id },
        data: { promptCache: updatedPrompt.content, promptHash: updatedPrompt.hash },
      });
    },
  });
}

async function waitForQueuedParent(run: { id: string; resumedFromRunId: string | null }): Promise<void> {
  let parentId = run.resumedFromRunId;
  const visited = new Set<string>();
  while (parentId) {
    if (visited.has(parentId)) throw new Error(`Cyclic queued follow-up dependency at Run ${parentId}`);
    const parent = await prisma.run.findUnique({
      where: { id: parentId },
      select: { id: true, status: true, startedAt: true, resumedFromRunId: true },
    });
    if (!parent) throw new Error(`Queued follow-up parent Run ${parentId} is unavailable.`);
    if (["PENDING", "RUNNING"].includes(parent.status) || isNativeCopilotRunActive(parent.id) || getManagedSessionController(parent.id)) {
      const current = await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
      if (current?.status !== "PENDING") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    visited.add(parentId);
    // A cancelled, unstarted predecessor can still have an active ancestor.
    if (parent.startedAt !== null) return;
    parentId = parent.resumedFromRunId;
  }
}

export async function executeWorkRun(runId: string): Promise<void> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { work: { include: { sessionPair: true } }, experimentVariant: { include: { experiment: true } } },
  });
  const work = run.work;
  if (!work) throw new Error(`Work run ${run.id} has no Work`);

  const pair = work.sessionPair ?? null;
  let artifactRoot: string;
  try {
    if (pair && (run.hostname !== hostname() || work.hostname !== hostname() || run.promptSnapshot === null ||
        run.taskId || run.experimentVariantId || !["WORK", "FOLLOW_UP"].includes(run.trigger))) {
      throw new WorkPairError("The paired Run does not match this host or managed Work.");
    }
    artifactRoot = await verifyPairedRunDirectory(work, run);
  }
  catch (error) {
    console.error("[Work Board] Cannot prepare paired Run output.", error);
    await prisma.run.updateMany({
      where: { id: run.id, status: "PENDING" },
      data: { status: "FAILED", finishedAt: new Date(), errorMessage: "The paired output directory is missing, redirected, or no longer matches this Run. No Prompt was sent." },
    });
    return;
  }
  const paired = Boolean(pair);
  const executionPath = run.executionPath ?? work.directoryPath;
  const prompt = run.promptSnapshot ?? work.promptCache;
  const attachments = parseWorkAttachments(run.attachmentsJson);
  const engine = run.engine ?? work.defaultEngine;
  const caseIqWebRun = isCaseIqWebRun(run);
  const outputFormat = run.outputFormat === "json" ? "json" : "text";
  const timeoutSeconds = run.timeoutSeconds;
  const sessionId = run.copilotSessionId ?? randomUUID();
  const caseIqLaunchOwner = { id: run.id, hostname: hostname(), copilotSessionId: sessionId, executionPath };
  const artifactPaths = getWorkRunArtifactPaths(artifactRoot, run.id);
  let beforeTree: string | null = null;
  let afterTree: string | null = null;
  let baseCommit: string | null = null;
  let finalCommit: string | null = null;
  let startedAt: Date | null = null;
  let queueClaimed = false;
  let runningClaimed = false;
  let releaseCaseIqPreparation: (() => void) | undefined;
  let caseIqPreparationStop: Promise<void> | undefined;
  let caseIqPreparationFinalizing = false;
  let caseIqCompletionSealed = false;
  let preparation: ReturnType<typeof beginWorkRunPreparation> | undefined;
  const caseIqVersions: CaseIqRunVersion[] = [];

  const captureBaseline = () => {
    preparation?.report({ phase: "snapshot" });
    const report = preparation?.report;
    return captureRunSourceBaseline(executionPath, artifactRoot, run.id,
      report && ((progress) => report({ phase: "snapshot", progress })), paired);
  };

  const snapshot = (overrides: Partial<WorkRunSnapshot> = {}): WorkRunSnapshot => ({
    schemaVersion: 1,
    runId: run.id,
    workId: work.id,
    workName: work.name,
    promptFileName: work.promptFileName,
    prompt,
    attachments,
    promptHash: hashWorkContent(prompt),
    engine,
    ...(run.providerId ? { providerId: run.providerId } : {}),
    ...(caseIqVersions.length ? { caseIqVersions: [...caseIqVersions] } : {}),
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
    model: run.model,
    fallbackModel: run.fallbackModel,
    contextTier: run.contextTier,
    reasoningEffort: run.reasoningEffort,
    permissionMode: run.permissionMode,
    outputFormat,
    timeoutSeconds,
    ...overrides,
  });

  const deferCaseIqRecovery = async (message: string, error: unknown) => {
    trackInterruptedCaseIqRun({ id: run.id, copilotSessionId: sessionId });
    console.error("[CaseIQ] Work remains reserved pending recovery.", error);
    try {
      await prisma.run.updateMany({ where: { id: run.id, status: "RUNNING" }, data: { errorMessage: message } });
    } catch (writeError) {
      console.error("[CaseIQ] Could not publish the Run recovery status.", run.id, writeError);
    }
  };

  const finishCaseIqPreparationStop = async (decision: Promise<void>) => {
    let message = "CaseIQ is checking its prelaunch cancellation. No Prompt was sent.";
    try {
      await decision;
      message = "CaseIQ is reconciling its saved cancellation. No Prompt was sent.";
      await settlePrelaunchCaseIqCancellation({ ...run, startedAt }, work, "CaseIQ was cancelled before launch. No Prompt was sent.", "RUNNING");
    } catch (error) {
      await deferCaseIqRecovery(message, error);
    }
  };

  try {
    if (run.providerId && (run.providerId !== "caseiq" || engine !== "CASEIQ") ||
        engine === "CASEIQ" && run.providerId !== "caseiq") {
      throw new Error("This Run does not have a supported web runtime binding. Native Terminal sessions cannot be executed as ordinary CLI.");
    }
    const pendingRun = await prisma.run.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    if (pendingRun?.status !== "PENDING") {
      if (!caseIqWebRun && pendingRun?.status === "CANCELLED") {
        await finalizeCancelledWorkRun(run.id, "Run was cancelled before it started.");
      }
      return;
    }
    if (engine === "CASEIQ") {
      releaseCaseIqPreparation = registerNativeRunControl(run.id, async () => {
        if (caseIqPreparationFinalizing && !caseIqPreparationStop) throw caseIqRunAlreadyFinalizing();
        caseIqPreparationStop ??= persistCaseIqPrelaunchCancellation(caseIqLaunchOwner);
        await caseIqPreparationStop;
        return true;
      });
      await prepareCaseIqRunLaunch(caseIqLaunchOwner, ensurePrivateRuntimeDirectory);
    }
    if (run.concurrencyMode === QUEUED_FOLLOW_UP_MODE) {
      await waitForQueuedParent(run);
      // Claim before Prompt sync so cancelling a waiting message cannot append it.
      startedAt = new Date();
      const claimed = await prisma.run.updateMany({
        where: { id: run.id, status: "PENDING" },
        data: { status: "RUNNING", startedAt, hostname: hostname(), logPath: artifactPaths.stdout, copilotSessionId: sessionId },
      });
      if (claimed.count === 0) {
        const current = await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
        if (!caseIqWebRun && current?.status === "CANCELLED") await finalizeCancelledWorkRun(run.id, "Run was cancelled before it started.");
        return;
      }
      queueClaimed = true;
      runningClaimed = true;
    }
    if (!queueClaimed) preparation = beginWorkRunPreparation(run.id);
    const prepareArtifacts = () => prepareWorkRunArtifacts(artifactRoot, run.id, snapshot({ status: queueClaimed ? "RUNNING" : run.status }));
    if (caseIqWebRun && !queueClaimed) {
      // Do not truncate a cancellation snapshot published while the job was preparing.
      const prepared = await serializeRunFinalization(run.id, async () => {
        const current = await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } });
        if (current?.status !== "PENDING") return false;
        await prepareArtifacts();
        return true;
      });
      if (!prepared) return;
    } else {
      await prepareArtifacts();
    }
    if (run.trigger === "FOLLOW_UP" && !paired) {
      await ensureFollowUpPrompt(work, run);
    }

    if (run.resumedFromRunId) {
      preparation?.report({ phase: "resume" });
      if (pair) {
        const parent = await prisma.run.findUnique({ where: { id: run.resumedFromRunId } });
        if (!parent || parent.workId !== work.id || parent.hostname !== hostname() ||
            parent.copilotSessionId !== sessionId || !matchesPairedWorkspace({ ...work, sessionPair: pair }, parent)) {
          throw new WorkPairError("The paired Follow Up no longer has its original parent Run. No Prompt was sent.");
        }
        await verifyPairedRunDirectory(work, parent);
        if (engine === "CLI" && readNativeSessionBindingSync(sessionId) || !await copilotSessionHasHistory(sessionId)) {
          throw new WorkPairError("The original paired Session has no usable history to resume. No Prompt was sent.");
        }
      }
      const parentPaths = getWorkRunArtifactPaths(artifactRoot, run.resumedFromRunId);
      const parentSnapshot = await readWorkRunSnapshot(parentPaths.snapshot).catch(() => null);
      // Older directory snapshots can contain only the parent's pre-run baseline.
      beforeTree = parentSnapshot && (!caseIqWebRun ||
        (parentSnapshot.finishedAt && (parentSnapshot.sourceAfterCaptured === true ||
          (parentSnapshot.sourceAfterCaptured === undefined && parentSnapshot.gitAfterTree))))
        ? await inheritRunSourceBaseline({
            sourceWorkDirectory: artifactRoot,
            sourceRunId: run.resumedFromRunId,
            sourceGitTree: parentSnapshot.gitAfterTree,
            targetWorkDirectory: artifactRoot,
            targetRunId: run.id,
          }).catch(captureBaseline)
        : await captureBaseline();
      preparation?.report({ phase: "resume" });
      await repairLegacyCopilotSessionEvents(sessionId);
    } else {
      beforeTree = await captureBaseline();
    }
    preparation?.report({ phase: "startup" });
    baseCommit = paired ? null : await getHeadCommit(executionPath).catch(() => null);
    startedAt ??= new Date();
    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: queueClaimed ? "RUNNING" : "PENDING" },
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
        if (!caseIqWebRun) await finalizeCancelledWorkRun(run.id, "Run was cancelled before it started.");
        return;
      }
      throw new Error(`Run ${run.id} could not be claimed from PENDING state`);
    }
    runningClaimed = true;
    preparation?.finish();
    if (run.experimentVariantId) {
      await prisma.experimentVariant.update({
        where: { id: run.experimentVariantId },
        data: { status: "RUNNING" },
      });
    }

    const onSpawn = async ({
      pid,
      command,
      model,
    }: {
      pid: number | null;
      command: string;
      model: string | null;
    }) => {
      try {
        await prisma.run.update({ where: { id: run.id }, data: { pid, command, model } });
      } catch (error) {
        console.error("[Work Board] Run process metadata could not be saved.", error);
      }
    };

    const currentStatus = await prisma.run.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    if (caseIqPreparationStop) {
      await finishCaseIqPreparationStop(caseIqPreparationStop);
      return;
    }
    if (currentStatus?.status === "CANCELLED") {
      if (!caseIqWebRun) await finalizeCancelledWorkRun(run.id);
      return;
    }

    if (pair) await verifyPairedRunDirectory(work, run);
    const messageAttachments = await runtimeWorkAttachments(work, attachments);
    const pairedWorkspace = paired
      ? await writePairedWorkspaceInstructions(work.directoryPath, artifactRoot, run.id, ensurePrivateRuntimeDirectory)
      : undefined;
    const deliveryPrompt = paired && !prompt.trim() && messageAttachments.length ? "Please review the attached files." : prompt;
    const sdkUsageBaseline = engine === "SDK"
      ? await readCopilotSessionInsights(sessionId).catch(() => null)
      : null;

    if (caseIqPreparationStop) {
      await finishCaseIqPreparationStop(caseIqPreparationStop);
      return;
    }
    // The runner registers its cancellation control synchronously, with no await between owners.
    releaseCaseIqPreparation?.();
    const result =
      engine === "CASEIQ"
        ? await startCaseIqRun({
            userId: work.userId, workId: work.id, runId: run.id, sessionId,
            authorizeLaunch: () => authorizeCaseIqRunLaunch(caseIqLaunchOwner),
            persistPrelaunchCancellation: (attempt) => persistCaseIqPrelaunchCancellation(caseIqLaunchOwner, attempt),
            repoPath: executionPath, prompt: deliveryPrompt, pairedWorkspace,
            attachmentPaths: messageAttachments.map((attachment) => attachment.path),
            resumeSession: Boolean(run.resumedFromRunId),
            agent: run.agent, model: run.model, fallbackModel: run.fallbackModel,
            contextTier: run.contextTier, reasoningEffort: run.reasoningEffort,
            ...resolveWorkCliOutputOptions("json"), timeoutSeconds,
            stdoutLogPath: artifactPaths.stdout, stderrLogPath: artifactPaths.stderr, onSpawn,
            onVersion: async (version) => {
              caseIqVersions.push(version);
              await writeRunSnapshot(artifactPaths.snapshot, snapshot({ status: "RUNNING" }));
            },
          })
      : engine === "SDK"
        ? await startCopilotSdkRun({
            runId: run.id,
            sessionId,
            workPath: executionPath,
            prompt: deliveryPrompt,
            attachments: messageAttachments,
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
            prompt: deliveryPrompt,
            pairedWorkspace,
            attachmentPaths: messageAttachments.map((attachment) => attachment.path),
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

    if (pair) await verifyPairedRunDirectory(work, run);
    const sourceDiff = await captureRunSourceDiff({
      executionPath,
      workDirectory: artifactRoot,
      runId: run.id,
      beforeGitTree: beforeTree,
    }).catch((error: unknown) => {
      if (!caseIqWebRun) throw error;
      const warning = "Workspace diff could not be collected.";
      console.warn("[CaseIQ] " + warning, run.id, error instanceof Error ? error.name : error);
      return { afterGitTree: null, diff: "", warning };
    });
    afterTree = sourceDiff.afterGitTree;
    finalCommit = paired ? null : await getHeadCommit(executionPath).catch(() => null);
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
        ...("warning" in sourceDiff ? { artifactWarnings: [sourceDiff.warning] } : {}),
        gitBeforeTree: beforeTree,
        gitAfterTree: afterTree,
        ...(caseIqWebRun ? { sourceAfterCaptured: !("warning" in sourceDiff) && (!beforeTree || afterTree !== null) } : {}),
        ...(engine === "CASEIQ" ? { model: result.model } : {}),
        ...usageData,
      }),
      finalOutput,
      diff,
      ...(engine === "CASEIQ" ? {
        seal: async (artifacts) => {
          await sealCaseIqRunCompletion({ ...caseIqLaunchOwner, workId: work.id }, {
            hasOutput: Boolean(finalOutput?.trim()), finalCommit, skillInvoked, artifacts,
          });
          caseIqCompletionSealed = true;
        },
      } : {}),
    });
    const outcome = {
      status,
      finalCommit,
      finalOutput,
      errorMessage,
      exitCode: result.exitCode,
      finishedAt,
      cpuTimeMs: result.cpuTimeMs,
      peakMemoryMb: result.peakMemoryMb,
      ...(engine === "CASEIQ" ? { model: result.model } : {}),
      ...usageData,
    } satisfies CaseIqWorkOutcome;
    if (engine === "CASEIQ") {
      await settleCaseIqWorkRun(run, outcome, { skillInvoked });
      return;
    }

    await prisma.run.update({ where: { id: run.id }, data: outcome });
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
    caseIqPreparationFinalizing = true;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof CaseIqRunUnconfirmedError || caseIqCompletionSealed) {
      const message = caseIqCompletionSealed
        ? "CaseIQ is reconciling its saved completion receipt after a finalization error."
        : errorMessage;
      await deferCaseIqRecovery(message, error);
      return;
    }
    if (caseIqPreparationStop && runningClaimed) {
      await finishCaseIqPreparationStop(caseIqPreparationStop);
      return;
    }
    if (engine === "CASEIQ" &&
        (await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } }))?.status === "CANCELLED") {
      if (!caseIqWebRun) await finalizeCancelledWorkRun(run.id);
      return;
    }
    const finishedAt = new Date();
    const publishFailureArtifacts = async (beforeLaunch = false) => {
      try {
        if (pair) await verifyPairedRunDirectory(work, run);
        const { afterGitTree, diff } = beforeLaunch ? { afterGitTree: null, diff: "" }
          : await captureRunSourceDiff({ executionPath, workDirectory: artifactRoot,
            runId: run.id, beforeGitTree: beforeTree }).catch(() => ({ afterGitTree: null, diff: "" }));
        afterTree = afterGitTree;
        finalCommit = paired || beforeLaunch ? null : await getHeadCommit(executionPath).catch(() => null);
        await finalizeWorkRunArtifacts({
          paths: artifactPaths, snapshot: snapshot({ status: "FAILED", finishedAt: finishedAt.toISOString(),
            errorMessage, gitBeforeTree: beforeTree, gitAfterTree: afterTree }),
          finalOutput: null, diff,
        });
      } catch (artifactError) {
        console.error("[Work Board] Could not finalize failed Run artifacts.", artifactError);
      }
    };
    if (caseIqWebRun && !runningClaimed) {
      await serializeRunFinalization(run.id, async () => {
        const settled = await settleCaseIqWorkRun(run, { status: "FAILED", errorMessage, finishedAt }, { expectedStatus: "PENDING" });
        if (settled) await publishFailureArtifacts(true);
      });
      return;
    }
    await publishFailureArtifacts();
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
  } finally {
    releaseCaseIqPreparation?.();
    preparation?.finish();
  }
}

type CaseIqWorkOutcome = Prisma.RunUpdateManyMutationInput & {
  status: "SUCCESS" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  errorMessage: string | null;
  finishedAt: Date;
};

export async function settleCaseIqWorkRun(
  run: Pick<Run, "id" | "workId" | "experimentVariantId">,
  outcome: CaseIqWorkOutcome,
  { skillInvoked, expectedStatus = "RUNNING" }: { skillInvoked?: boolean | null; expectedStatus?: "PENDING" | "RUNNING" } = {},
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const settled = await tx.run.updateMany({ where: { id: run.id, status: expectedStatus }, data: outcome });
    if (!settled.count) return false;

    const { status, errorMessage } = outcome;
    if (run.experimentVariantId) {
      const { experimentId } = await tx.experimentVariant.update({
        where: { id: run.experimentVariantId },
        data: {
          status: status === "SUCCESS" || status === "CANCELLED" ? status : "FAILED",
          ...(skillInvoked === undefined ? {} : { skillInvoked }),
          errorMessage: status === "SUCCESS" ? null : errorMessage ?? (status === "CANCELLED" ? null : `Run finished with status ${status}`),
        },
        select: { experimentId: true },
      });
      await refreshExperimentStatus(experimentId, tx);
    }
    if (run.workId) {
      await projectSettledWorkState(tx, run.workId, status === "SUCCESS" ? "REVIEW" : "ACTIVE");
    }
    return true;
  });
}

async function projectSettledWorkState(database: Pick<Prisma.TransactionClient, "work">, workId: string, status: "REVIEW" | "ACTIVE") {
  await database.work.updateMany({
    where: {
      id: workId,
      status: { not: "ARCHIVED" },
      runs: { none: { status: { in: ["PENDING", "RUNNING"] } } },
    },
    data: { status },
  });
}

export async function refreshExperimentStatus(
  experimentId: string,
  database: Pick<Prisma.TransactionClient, "experimentVariant" | "experiment"> = prisma,
): Promise<void> {
  const variants = await database.experimentVariant.findMany({
    where: { experimentId },
    select: { status: true },
  });
  const active = variants.some((variant) =>
    ["COPYING", "READY", "RUNNING"].includes(variant.status)
  );
  if (active) {
    await database.experiment.updateMany({
      where: { id: experimentId, status: { in: ["PROVISIONING", "RUNNING"] } },
      data: { status: "RUNNING" },
    });
    return;
  }
  await database.experiment.updateMany({
    where: { id: experimentId, status: { in: ["PROVISIONING", "RUNNING"] } },
    data: { status: "COMPLETED", finishedAt: new Date() },
  });
}

const cancellationRelations = { work: { include: { sessionPair: true } }, experimentVariant: true } satisfies Prisma.RunInclude;
type CancellationRun = Prisma.RunGetPayload<{ include: typeof cancellationRelations }>;

export async function cancelPendingCaseIqWorkRun(runId: string, message: string): Promise<boolean> {
  return serializeRunFinalization(runId, async () => {
    const run = await prisma.run.findUnique({ where: { id: runId }, include: cancellationRelations });
    if (!run?.work || run.status !== "PENDING" || !isCaseIqWebRun(run)) return false;
    return settlePrelaunchCaseIqCancellation(run, run.work, message, "PENDING");
  });
}

async function settlePrelaunchCaseIqCancellation(
  run: CancellationRun,
  work: NonNullable<CancellationRun["work"]>,
  message: string,
  expectedStatus: "PENDING" | "RUNNING",
): Promise<boolean> {
  const finishedAt = new Date();
  const cancelled = await settleCaseIqWorkRun(run, {
    status: "CANCELLED", finishedAt, finalOutput: message, errorMessage: null,
  }, { expectedStatus });
  if (!cancelled) return false;
  try {
    const artifactRoot = await verifyPairedRunDirectory(work, run);
    await writeCancelledWorkRunArtifacts(run, work, artifactRoot, message, finishedAt, true);
  } catch (error) {
    console.error("[CaseIQ] Run was cancelled before launch, but cancellation artifacts could not be saved.", run.id, error);
  }
  return true;
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
    include: cancellationRelations,
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
  let artifactRoot: string;
  try { artifactRoot = await verifyPairedRunDirectory(work, run); }
  catch (error) {
    console.error("[Work Board] Could not write cancellation artifacts to the paired directory.", error);
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "CANCELLED", finishedAt: new Date(), errorMessage: "Run was cancelled. Its original output directory could not be verified." },
    });
    return;
  }
  const finishedAt = new Date();
  await writeCancelledWorkRunArtifacts(run, work, artifactRoot, message, finishedAt);

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
  await projectSettledWorkState(prisma, work.id, "ACTIVE");
}

async function writeCancelledWorkRunArtifacts(
  run: CancellationRun,
  work: NonNullable<CancellationRun["work"]>,
  artifactRoot: string,
  message: string,
  finishedAt: Date,
  beforeLaunch = false,
) {
  const executionPath = run.executionPath ?? work.directoryPath;
  const paths = getWorkRunArtifactPaths(artifactRoot, run.id);
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
      ...(run.providerId ? { providerId: run.providerId } : {}),
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
    await prepareWorkRunArtifacts(artifactRoot, run.id, snapshot);
  }
  const { afterGitTree, diff } = beforeLaunch ? { afterGitTree: null, diff: "" } : await captureRunSourceDiff({
    executionPath,
    workDirectory: artifactRoot,
    runId: run.id,
    beforeGitTree: snapshot.gitBeforeTree,
  }).catch(() => ({ afterGitTree: null, diff: "" }));
  await finalizeWorkRunArtifacts({
    paths,
    snapshot: {
      ...snapshot,
      status: "CANCELLED",
      ...(beforeLaunch ? { startedAt: run.startedAt?.toISOString() ?? null } : {}),
      finishedAt: finishedAt.toISOString(),
      gitAfterTree: afterGitTree,
    },
    finalOutput: message,
    diff,
  });
}