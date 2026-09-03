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
  repairLegacyCopilotSessionEvents,
} from "@/lib/copilot-session-compat";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import { findActiveRunConflicts } from "@/lib/run-access";

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
    const result = await withRunStartLock([`work:${candidate.id}`], async () => {
      const work = await prisma.work.findFirst({ where: { id, userId } });
      if (!work) throw new FollowUpConflictError("Work not found", 404);
      if (work.status === "ARCHIVED") {
        throw new FollowUpConflictError("Restore this Work before following up");
      }
      const activeWorkRun = await prisma.run.findFirst({
        where: { workId: work.id, status: { in: ["PENDING", "RUNNING"] } },
        select: { id: true },
      });
      if (activeWorkRun) {
        throw new FollowUpConflictError("Wait for the active Work Run to finish");
      }
      let parent = await prisma.run.findFirst({
        where: {
          workId: work.id,
          experimentVariantId: null,
          copilotSessionId: { not: null },
          status: { notIn: ["PENDING", "RUNNING"] },
          startedAt: { not: null },
        },
        orderBy: { createdAt: "desc" },
      });
      if (parent?.hostname && parent.hostname !== hostname()) {
        throw new FollowUpConflictError("The latest Work session belongs to another machine");
      }
      if (
        parent?.copilotSessionId &&
        !(await copilotSessionExists(parent.copilotSessionId))
      ) {
        parent = null;
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
          await repairLegacyCopilotSessionEvents(parent.copilotSessionId);
        }

        const run = await createPendingFollowUpRun({
          workId: work.id,
          prompt: parsed.data.prompt,
          parentRunId: parent?.id,
        });
        try {
          await ensureFollowUpPrompt(work, run);
        } catch (error) {
          console.warn(`[follow-up] Deferring prompt sync for Run ${run.id}:`, error);
        }
        jobQueue.enqueue(getWorkRunQueueKey(run), () => executeWorkRun(run.id));
        return { runId: run.id, resumed: Boolean(parent) };
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
    if (error instanceof RunStartInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start Follow Up" },
      { status: 400 }
    );
  }
}

class FollowUpConflictError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "FollowUpConflictError";
  }
}