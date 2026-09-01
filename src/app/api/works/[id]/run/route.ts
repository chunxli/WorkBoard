import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jobQueue } from "@/lib/job-queue";
import { getSessionUserId } from "@/lib/session";
import { runWorkSchema } from "@/lib/validation";
import { copyWorkToNumberedSibling, readWorkPrompt } from "@/lib/work-files";
import { createPendingWorkRun, executeWorkRun } from "@/lib/work-executor";
import { findActiveRunConflicts } from "@/lib/run-access";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const work = await prisma.work.findFirst({ where: { id, userId } });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404 });
  if (work.status === "ARCHIVED") {
    return NextResponse.json({ error: "Restore this Work before running it" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = runWorkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const conflictingRuns = await findActiveRunConflicts(userId, work.directoryPath);

  let executionPath = work.directoryPath;
  let concurrencyMode = conflictingRuns.length > 0 ? "DIRECT_UNSAFE" : "DIRECT";
  if (conflictingRuns.length > 0 && parsed.data.conflictMode === "COPY_ON_CONFLICT") {
    executionPath = await copyWorkToNumberedSibling(work.directoryPath);
    concurrencyMode = "COPIED_ON_CONFLICT";
  }

  try {
    const prompt = await readWorkPrompt(work);
    const run = await createPendingWorkRun({
      workId: work.id,
      engine: parsed.data.engine ?? work.defaultEngine,
      executionPath,
      prompt: prompt.content,
      concurrencyMode,
    });
    jobQueue.enqueue(run.id, () => executeWorkRun(run.id));
    return NextResponse.json(
      { runId: run.id, conflictCount: conflictingRuns.length, concurrencyMode, executionPath },
      { status: 202 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start Work" },
      { status: 400 }
    );
  }
}