import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jobQueue } from "@/lib/job-queue";
import { getSessionUserId } from "@/lib/session";
import { runWorkSchema } from "@/lib/validation";
import { copyWorkToNumberedSibling, readWorkPrompt } from "@/lib/work-files";
import { createPendingWorkRun, executeWorkRun } from "@/lib/work-executor";
import { findActiveRunConflicts } from "@/lib/run-access";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = runWorkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await withRunStartLock([`work:${id}`], async () => {
      const work = await prisma.work.findFirst({ where: { id, userId } });
      if (!work) throw new WorkStartError("Work not found", 404);
      if (work.status === "ARCHIVED") {
        throw new WorkStartError("Restore this Work before running it");
      }
      const activeFollowUp = await prisma.run.findFirst({
        where: {
          workId: work.id,
          trigger: "FOLLOW_UP",
          status: { in: ["PENDING", "RUNNING"] },
        },
        select: { id: true },
      });
      if (activeFollowUp) {
        throw new WorkStartError("Wait for the active Follow Up to finish");
      }
      const conflictingRuns = await findActiveRunConflicts(userId, work.directoryPath);
      let executionPath = work.directoryPath;
      let concurrencyMode = conflictingRuns.length > 0 ? "DIRECT_UNSAFE" : "DIRECT";
      if (conflictingRuns.length > 0 && parsed.data.conflictMode === "COPY_ON_CONFLICT") {
        executionPath = await copyWorkToNumberedSibling(work.directoryPath);
        concurrencyMode = "COPIED_ON_CONFLICT";
      }
      const prompt = await readWorkPrompt(work);
      const run = await createPendingWorkRun({
        workId: work.id,
        engine: parsed.data.engine ?? work.defaultEngine,
        executionPath,
        prompt: prompt.content,
        concurrencyMode,
      });
      jobQueue.enqueue(run.id, () => executeWorkRun(run.id));
      return {
        runId: run.id,
        conflictCount: conflictingRuns.length,
        concurrencyMode,
        executionPath,
      };
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof WorkStartError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof RunStartInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start Work" },
      { status: 400 }
    );
  }
}

class WorkStartError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "WorkStartError";
  }
}