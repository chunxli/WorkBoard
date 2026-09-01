import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateTaskSchema } from "@/lib/validation";
import { getSessionUserId } from "@/lib/session";
import cron from "node-cron";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const task = await prisma.task.findFirst({
    where: { id, repo: { userId } },
    include: { repo: true, runs: { orderBy: { createdAt: "desc" } } },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.task.findFirst({ where: { id, repo: { userId } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = updateTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const model = parsed.data.model === undefined ? existing.model : parsed.data.model;
  const fallbackModel =
    parsed.data.fallbackModel === undefined ? existing.fallbackModel : parsed.data.fallbackModel;
  if (fallbackModel && !model) {
    return NextResponse.json({ error: "A primary model is required when fallbackModel is set" }, { status: 400 });
  }
  if (fallbackModel && fallbackModel === model) {
    return NextResponse.json({ error: "fallbackModel must differ from model" }, { status: 400 });
  }

  const triggerType = parsed.data.triggerType ?? existing.triggerType;
  const cronExpression =
    parsed.data.cronExpression === undefined
      ? existing.cronExpression
      : parsed.data.cronExpression;
  if (triggerType === "SCHEDULE" && (!cronExpression || !cron.validate(cronExpression))) {
    return NextResponse.json(
      { error: "A valid cronExpression is required when triggerType is SCHEDULE" },
      { status: 400 }
    );
  }

  if (parsed.data.repoId) {
    const repo = await prisma.repo.findUnique({ where: { id: parsed.data.repoId, userId } });
    if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });
  }

  const task = await prisma.task.update({ where: { id }, data: parsed.data });
  return NextResponse.json(task);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.task.findFirst({ where: { id, repo: { userId } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.task.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
