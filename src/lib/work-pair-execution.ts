import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { v5 as uuidV5 } from "uuid";
import type { Prisma, Run } from "@/generated/prisma/client";
import { getCaseIqInstallation, getCaseIqPromptPowerShell } from "@/lib/caseiq-installation";
import { isCaseIqAuthenticationCommand } from "@/lib/caseiq-options";
import { copilotSessionHasHistory } from "@/lib/copilot-session-compat";
import { isNativeCopilotRunActive } from "@/lib/copilot-runner";
import { jobQueue } from "@/lib/job-queue";
import { nativeSessionBindingHome, readNativeSessionBindingSync } from "@/lib/native-session-bindings";
import { prisma } from "@/lib/prisma";
import { findActiveRunConflicts } from "@/lib/run-access";
import { getWorkRunArtifactPaths } from "@/lib/run-artifacts";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import { getTerminalSessionActivity } from "@/lib/terminal-resume";
import { readWorkPrompt } from "@/lib/work-files";
import { parseWorkAttachments, readInitialWorkAttachments, resolveWorkAttachments, WorkAttachmentError } from "@/lib/work-attachments";
import type { WorkAttachment } from "@/lib/work-attachment-types";
import { executeWorkRun, resolveFollowUpExecutionSettings } from "@/lib/work-executor";
import {
  getWorkRunQueueKey, getWorkQueueBlockedReason, orderPendingWorkRuns, QUEUED_FOLLOW_UP_MODE,
} from "@/lib/work-run-queue";
import {
  assertPairedInputDirectory, matchesPairedWorkspace, pairedWorkspacePath, provisionPairedWorkspaces, verifyPairedWorkspaces, WorkPairError,
} from "@/lib/work-pair-directories";
import {
  pairedLaneInfo, pairedSessionId, pairedWorkLane, pairedWorkLanes, type PairedWorkFollowUp,
  type PairedWorkLane, type WorkSessionPairIds,
} from "@/lib/work-session-pair";

type OwnedWork = Prisma.WorkGetPayload<{ include: { sessionPair: true } }>;

export class PairedAdmissionRejectedError extends WorkPairError {}

async function ownedLocalWork(userId: string, workId: string) {
  const work = await prisma.work.findFirst({ where: { userId, id: workId }, include: { sessionPair: true } });
  if (!work) throw new WorkPairError("Work not found.", 404);
  if (work.hostname !== hostname()) throw new WorkPairError("Open this Work on its verified owning Windows host.");
  return work;
}

function assertLane(work: OwnedWork, pair: WorkSessionPairIds, run: Run) {
  if (run.workId !== work.id || run.taskId !== null || run.experimentVariantId !== null ||
      !["WORK", "FOLLOW_UP"].includes(run.trigger) || run.hostname !== hostname() ||
      !matchesPairedWorkspace({ directoryPath: work.directoryPath, sessionPair: pair }, run)) {
    throw new WorkPairError("A Run does not match the saved paired Session. Neither Session was sent a message.");
  }
}

function receipt(pair: WorkSessionPairIds, runs: Run[]) {
  return { runs: runs.map((run) => {
    const lane = pairedWorkLane(pair, run.copilotSessionId);
    if (!lane) throw new WorkPairError("A Run is outside the saved Session pair.");
    return { lane, runId: run.id, sessionId: pairedSessionId(pair, lane), queued: run.concurrencyMode === QUEUED_FOLLOW_UP_MODE };
  }) };
}

function enqueue(runs: Run[]) {
  for (const run of runs) jobQueue.enqueue(getWorkRunQueueKey(run), () => executeWorkRun(run.id));
}

function pairedRunData(options: {
  work: OwnedWork;
  pair: WorkSessionPairIds;
  lane: PairedWorkLane;
  id: string;
  prompt: string;
  attachments: WorkAttachment[];
  parent?: Run;
  queue?: boolean;
}): Prisma.RunCreateManyInput {
  const { work, pair, lane, id, prompt, attachments, parent, queue } = options;
  const executionPath = pairedWorkspacePath(work.directoryPath, pair, lane);
  const settings = resolveFollowUpExecutionSettings(work, parent ?? null);
  return {
    ...settings,
    id, workId: work.id, hostname: hostname(), status: "PENDING", engine: lane,
    providerId: lane === "CASEIQ" ? "caseiq" : null,
    permissionMode: lane === "CASEIQ" ? "default" : settings.permissionMode,
    outputFormat: lane === "CASEIQ" ? "json" : parent?.outputFormat ?? work.outputFormat,
    trigger: parent ? "FOLLOW_UP" : "WORK", promptSnapshot: prompt,
    executionPath, outputDir: getWorkRunArtifactPaths(executionPath, id).outputDirectory,
    copilotSessionId: pairedSessionId(pair, lane),
    attachmentsJson: attachments.length ? JSON.stringify(attachments) : null,
    resumedFromRunId: parent?.id ?? null,
    concurrencyMode: queue ? QUEUED_FOLLOW_UP_MODE : parent ? "FOLLOW_UP_RESUME" : "DIRECT",
  };
}

export async function startPairedWork(userId: string, workId: string) {
  return withRunStartLock([`work:${workId}`], async () => {
    const work = await ownedLocalWork(userId, workId);
    if (work.sessionPair) {
      const { sessionPair: pair } = work;
      const initial = await prisma.run.findMany({
        where: { workId, trigger: "WORK", copilotSessionId: { in: [pair.cliSessionId, pair.caseIqSessionId] } },
      });
      if (initial.length !== 2 || new Set(initial.map((run) => run.copilotSessionId)).size !== 2) {
        throw new WorkPairError("Original paired Runs are unavailable. No Session was restarted.");
      }
      initial.forEach((run) => assertLane(work, pair, run));
      return receipt(pair, initial);
    }
    if (work.status === "ARCHIVED") throw new WorkPairError("Restore this Work before starting its Sessions.");

    if (await prisma.run.count({ where: { workId } }) || await prisma.task.count({ where: { workId } })) {
      throw new WorkPairError("Start both Sessions on a new Work without Runs or Automations.");
    }
    const [installation] = await Promise.all([getCaseIqInstallation(), getCaseIqPromptPowerShell()]);
    const root = work.directoryPath;
    await assertPairedInputDirectory(root, installation.root);
    if ((await findActiveRunConflicts(userId, root, true)).length) {
      throw new WorkPairError("Wait for the Run using this Work directory to finish.");
    }
    const [attachments, savedPrompt] = await Promise.all([readInitialWorkAttachments(work), readWorkPrompt(work)]);
    const prompt = savedPrompt.content.trim() ? savedPrompt.content : attachments.length ? "Please review the attached files." : "";
    if (!prompt.trim() || isCaseIqAuthenticationCommand(prompt)) {
      throw new WorkPairError("Enter a task Prompt or attach a file before starting both Sessions.", 400);
    }

    const pair = { cliSessionId: randomUUID(), caseIqSessionId: randomUUID() };
    const directories = await provisionPairedWorkspaces(root, pair);
    let runs;
    try {
      const records = pairedWorkLanes.map((lane) => pairedRunData({ work, pair, lane, id: randomUUID(), prompt, attachments }));
      const [, cli, caseIq] = await prisma.$transaction([
        prisma.workSessionPair.create({ data: { workId, ...pair } }),
        prisma.run.create({ data: records[0] }),
        prisma.run.create({ data: records[1] }),
      ]);
      runs = [cli, caseIq];
    } catch (error) {
      await directories.discardEmpty();
      throw error;
    }
    enqueue(runs);
    return receipt(pair, runs);
  });
}

function pairedFollowUpId(workId: string, requestId: string, lane: PairedWorkLane) {
  return uuidV5(JSON.stringify(["workboard-paired-follow-up", workId, requestId, lane]), uuidV5.URL);
}

async function admitPairedFollowUp(work: OwnedWork, pair: WorkSessionPairIds, request: PairedWorkFollowUp) {
  const { id: workId, userId, directoryPath: root } = work;
  await verifyPairedWorkspaces(root, pair, request.targets.map(({ lane }) => lane));
  const active = await prisma.run.findMany({ where: { workId, status: { in: ["PENDING", "RUNNING"] } } });
  active.forEach((run) => assertLane(work, pair, run));
  const activeIds = new Set(active.map(({ id }) => id));
  const conflicts = await findActiveRunConflicts(userId, root, true);
  if (conflicts.some(({ id }) => !activeIds.has(id))) {
    throw new WorkPairError("Wait for the other Run using this Work directory to finish.");
  }
  const parents = [];
  for (const { lane, expectedParentRunId } of request.targets) {
    const sessionId = pairedSessionId(pair, lane);
    const label = pairedLaneInfo[lane].label;
    const laneActive = active.filter((run) => run.copilotSessionId === sessionId);
    const parent = orderPendingWorkRuns(laneActive).at(-1) ?? await prisma.run.findFirst({
      where: { workId, copilotSessionId: sessionId, experimentVariantId: null,
        status: { notIn: ["PENDING", "RUNNING"] }, startedAt: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!parent || parent.id !== expectedParentRunId) {
      throw new WorkPairError(`${label}'s selected Run changed. Refresh the Conversation before sending.`);
    }
    assertLane(work, pair, parent);
    if (await prisma.run.count({ where: { copilotSessionId: sessionId, OR: [{ workId: null }, { workId: { not: workId } }] } })) {
      throw new WorkPairError(`${label}'s Session is also associated with another Work.`);
    }
    if (laneActive.length) {
      const blocked = getWorkQueueBlockedReason(laneActive, sessionId, hostname());
      if (blocked) throw new WorkPairError(`${label}: ${blocked}`);
    } else {
      const binding = readNativeSessionBindingSync(sessionId);
      if (lane === "CASEIQ" && (!binding || binding.userId !== userId || binding.workId !== workId ||
          !parent.executionPath || path.relative(binding.workingDirectory, parent.executionPath) !== "" || !nativeSessionBindingHome(binding)) ||
          lane === "CLI" && binding) {
        throw new WorkPairError(`${label}'s original Session binding is unavailable. No other Session was used.`);
      }
      if (!await copilotSessionHasHistory(sessionId)) {
        throw new WorkPairError(`${label} has no recorded Session to resume. Check its first Run before trying again.`);
      }
    }
    if (!laneActive.some((run) => isNativeCopilotRunActive(run.id))) {
      const activity = await getTerminalSessionActivity(sessionId, null);
      if (activity.active || activity.starting) throw new WorkPairError(`Close ${label}'s Terminal before sending.`);
    }
    parents.push({ lane, parent, queue: laneActive.length > 0 });
  }
  const attachments = request.attachmentIds.length
    ? await resolveWorkAttachments(work, request.requestId, request.attachmentIds, true) : [];
  return prisma.$transaction(parents.map(({ lane, parent, queue }) =>
    prisma.run.create({ data: pairedRunData({ work, pair, lane, parent, queue,
      id: pairedFollowUpId(workId, request.requestId, lane), prompt: request.prompt, attachments }) })));
}

export async function sendPairedFollowUp(userId: string, workId: string, request: PairedWorkFollowUp) {
  if (isCaseIqAuthenticationCommand(request.prompt)) {
    throw new WorkPairError("Use Sign in to SupportIQ in the CaseIQ pane. The sign-in command is not sent to either Session.", 400);
  }
  return withRunStartLock([`work:${workId}`], async () => {
    const work = await ownedLocalWork(userId, workId);
    const pair = work.sessionPair;
    if (!pair) throw new WorkPairError("Start both Sessions before using paired Follow Up.");
    const ids = pairedWorkLanes.map((lane) => pairedFollowUpId(workId, request.requestId, lane));
    const existing = await prisma.run.findMany({ where: { id: { in: ids } } });
    if (existing.length) {
      if (existing.length !== request.targets.length || existing.some((run) => {
        const target = request.targets.find(({ lane }) => pairedFollowUpId(workId, request.requestId, lane) === run.id);
        return !target || run.trigger !== "FOLLOW_UP" || run.copilotSessionId !== pairedSessionId(pair, target.lane) ||
          run.resumedFromRunId !== target.expectedParentRunId || run.promptSnapshot !== request.prompt ||
          JSON.stringify(parseWorkAttachments(run.attachmentsJson).map(({ id }) => id)) !== JSON.stringify(request.attachmentIds);
      })) throw new WorkPairError("This request ID already refers to a different paired message.");
      existing.forEach((run) => assertLane(work, pair, run));
      return receipt(pair, existing);
    }

    let runs;
    try {
      if (work.status === "ARCHIVED") throw new WorkPairError("Restore this Work before sending to its Sessions.");
      runs = await withRunStartLock(request.targets.map(({ lane }) => `session:${pairedSessionId(pair, lane)}`),
        () => admitPairedFollowUp(work, pair, request));
    } catch (error) {
      if (error instanceof WorkPairError || error instanceof WorkAttachmentError || error instanceof RunStartInProgressError) {
        throw new PairedAdmissionRejectedError(error.message, "status" in error ? error.status : 409, { cause: error });
      }
      throw error;
    }
    enqueue(runs);
    return receipt(pair, runs);
  }, { checkWorkAuthentication: false });
}
