import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyGithubSignature } from "@/lib/crypto";
import { jobQueue } from "@/lib/job-queue";
import { createPendingRun, executeRun } from "@/lib/task-executor";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ repoId: string }> }
) {
  const { repoId } = await params;

  const webhookConfig = await prisma.webhookConfig.findUnique({ where: { repoId } });
  if (!webhookConfig) {
    return NextResponse.json({ error: "No webhook configured for this repo" }, { status: 404 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifyGithubSignature(webhookConfig.secret, rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const eventType = req.headers.get("x-github-event") ?? "";

  const tasks = await prisma.task.findMany({
    where: { repoId, triggerType: "WEBHOOK", enabled: true, archivedAt: null },
  });

  const matchingTasks = tasks.filter((task) =>
    (task.webhookEvents ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .includes(eventType)
  );

  for (const task of matchingTasks) {
    const run = await createPendingRun(task.id, "WEBHOOK");
    jobQueue.enqueue(task.repoId, () => executeRun(run.id), task.waitForPreviousRuns);
  }

  return NextResponse.json({ triggered: matchingTasks.length }, { status: 202 });
}
