import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jobQueue } from "@/lib/job-queue";
import { createPendingRun, executeRun } from "@/lib/task-executor";
import { getSessionUserId } from "@/lib/session";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const task = await prisma.task.findFirst({ where: { id, archivedAt: null, repo: { userId } } });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const run = await createPendingRun(task.id, "MANUAL");
  jobQueue.enqueue(task.repoId, () => executeRun(run.id), task.waitForPreviousRuns);

  return NextResponse.json({ runId: run.id }, { status: 202 });
}
