import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { followUpWorkSchema } from "@/lib/validation";
import {
  createPendingFollowUpRun,
  ensureFollowUpPrompt,
  executeWorkRun,
  getWorkRunQueueKey,
} from "@/lib/work-executor";
import { jobQueue } from "@/lib/job-queue";
import {
  copilotSessionExists,
  CopilotSessionInUseError,
  repairLegacyCopilotSessionEvents,
} from "@/lib/copilot-session-compat";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import { findActiveRunConflicts } from "@/lib/run-access";
import { getTerminalSessionActivity, reconcileTerminalRun } from "@/lib/terminal-resume";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { parseWorkAttachments, resolveWorkAttachments, WorkAttachmentError } from "@/lib/work-attachments";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = followUpWorkSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { id } = await params;
  const candidate = await prisma.work.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!candidate) return NextResponse.json({ error: "Work not found" }, { status: 404 });

  try {
    if (parsed.data.expectedParentRunId) {
      const expected = await prisma.run.findFirst({
        where: { id: parsed.data.expectedParentRunId, workId: id, experimentVariantId: null },
        select: { id: true, status: true, trigger: true, hostname: true },
      });
      if (!expected) throw new FollowUpConflictError("The displayed session is no longer available. Refresh the conversation.");
      if (expected.hostname && expected.hostname !== hostname()) throw new FollowUpConflictError("This session belongs to another machine");
      if (expected.status === "RUNNING" && isTerminalRunTrigger(expected.trigger)) {
        await reconcileTerminalRun(expected.id, new Date(), { settleStopped: true });
      }
    }
    const result = await withRunStartLock([`work:${candidate.id}`], async () => {
      const work = await prisma.work.findFirst({ where: { id, userId } });
      if (!work) throw new FollowUpConflictError("Work not found", 404);
      if (work.status === "ARCHIVED") {
        throw new FollowUpConflictError("Restore this Work before following up");
      }
      if (work.hostname && work.hostname !== hostname()) throw new FollowUpConflictError("This Work belongs to another machine");
      if (parsed.data.requestId) {
        const existing = await prisma.run.findUnique({ where: { id: parsed.data.requestId } });
        if (existing) {
          if (existing.workId !== work.id || existing.trigger !== "FOLLOW_UP" ||
            existing.promptSnapshot !== parsed.data.prompt ||
            parsed.data.expectedParentRunId !== undefined && existing.resumedFromRunId !== parsed.data.expectedParentRunId ||
            JSON.stringify(parseWorkAttachments(existing.attachmentsJson).map((file) => file.id)) !== JSON.stringify(parsed.data.attachmentIds)) {
            throw new FollowUpConflictError("This request ID already refers to a different message.");
          }
          return { runId: existing.id, sessionId: existing.copilotSessionId, resumed: Boolean(existing.resumedFromRunId) };
        }
      }
      const activeWorkRun = await prisma.run.findFirst({
        where: { workId: work.id, status: { in: ["PENDING", "RUNNING"] } },
        select: { id: true },
      });
      if (activeWorkRun) {
        throw new FollowUpConflictError("Wait for the active Work Run to finish");
      }
      const parent = await prisma.run.findFirst({
        where: {
          workId: work.id,
          experimentVariantId: null,
          copilotSessionId: { not: null },
          status: { notIn: ["PENDING", "RUNNING"] },
          startedAt: { not: null },
        },
        orderBy: { createdAt: "desc" },
        include: { terminalLaunches: { select: { id: true }, take: 1 } },
      });
      if (parsed.data.expectedParentRunId !== undefined && (parent?.id ?? null) !== parsed.data.expectedParentRunId) {
        throw new FollowUpConflictError("The session has changed. Refresh the conversation before sending.");
      }
      if (parent?.hostname && parent.hostname !== hostname()) {
        throw new FollowUpConflictError("The latest Work session belongs to another machine");
      }
      if (
        parent?.copilotSessionId &&
        !(await copilotSessionExists(parent.copilotSessionId))
      ) {
        throw new FollowUpConflictError("Session history is unavailable. Start a new Work Run explicitly.");
      }
      const conflictingRuns = await findActiveRunConflicts(
        userId,
        parent?.executionPath ?? work.directoryPath
      );
      if (conflictingRuns.length > 0) {
        throw new FollowUpConflictError("Wait for the active Run in this Work directory to finish");
      }
      const createFollowUp = async () => {
        if (parent?.copilotSessionId) {
          const activeSessionRun = await prisma.run.findFirst({
            where: {
              copilotSessionId: parent.copilotSessionId,
              status: { in: ["PENDING", "RUNNING"] },
            },
            select: { id: true },
          });
          if (activeSessionRun) {
            throw new FollowUpConflictError("The Copilot session is already active");
          }
          const activity = await getTerminalSessionActivity(parent.copilotSessionId, parent.terminalLaunches[0]?.id ?? null);
          if (activity.active) throw new FollowUpConflictError("This session is open in Terminal. Close the Copilot session before sending.");
          await repairLegacyCopilotSessionEvents(parent.copilotSessionId);
        }

        const attachments = parsed.data.attachmentIds.length && parsed.data.requestId
          ? await resolveWorkAttachments(work, parsed.data.requestId, parsed.data.attachmentIds, true) : [];
        const run = await createPendingFollowUpRun({
          workId: work.id,
          prompt: parsed.data.prompt,
          parentRunId: parent?.id,
          requestId: parsed.data.requestId,
          attachments,
        });
        try {
          await ensureFollowUpPrompt(work, run);
        } catch (error) {
          console.warn(`[follow-up] Deferring prompt sync for Run ${run.id}:`, error);
        }
        jobQueue.enqueue(getWorkRunQueueKey(run), () => executeWorkRun(run.id));
        return { runId: run.id, sessionId: run.copilotSessionId, resumed: Boolean(parent) };
      };

      return parent?.copilotSessionId
        ? withRunStartLock([`session:${parent.copilotSessionId}`], createFollowUp)
        : createFollowUp();
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof FollowUpConflictError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof WorkAttachmentError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof RunStartInProgressError || error instanceof CopilotSessionInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[follow-up] Failed to create or enqueue Follow Up:", error);
    return NextResponse.json({ error: "Unable to confirm Follow Up. Retry this same request." }, { status: 500 });
  }
}

class FollowUpConflictError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "FollowUpConflictError";
  }
}