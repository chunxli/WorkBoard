import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto";
import { jobQueue } from "@/lib/job-queue";
import { createPendingRun, executeRun } from "@/lib/task-executor";

const triggerSchema = z.object({ taskId: z.string().min(1) });

async function authenticate(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const rawToken = auth.slice("Bearer ".length).trim();
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const record = await prisma.apiToken.findUnique({ where: { tokenHash } });
  if (!record) return null;

  await prisma.apiToken.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } });
  return record.userId;
}

export async function POST(req: NextRequest) {
  const userId = await authenticate(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = triggerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Verify the token's owner actually owns the repo the task belongs to — otherwise any valid
  // token could trigger any task in the system regardless of who created it.
  const task = await prisma.task.findFirst({
    where: { id: parsed.data.taskId, archivedAt: null, repo: { userId } },
  });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const run = await createPendingRun(task.id, "API");
  jobQueue.enqueue(task.repoId, () => executeRun(run.id), task.waitForPreviousRuns);

  return NextResponse.json({ runId: run.id }, { status: 202 });
}

