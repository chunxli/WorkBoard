import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createTaskSchema } from "@/lib/validation";
import { getSessionUserId } from "@/lib/session";
import cron from "node-cron";
import { getUserExecutionDefaults } from "@/lib/user-execution-defaults";
import { automationDefaultsPayload } from "@/lib/execution-defaults";

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tasks = await prisma.task.findMany({
    where: {
      repo: { userId },
      archivedAt: req.nextUrl.searchParams.get("view") === "archived" ? { not: null } : null,
    },
    orderBy: { createdAt: "desc" },
    include: { repo: true, runs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return NextResponse.json(tasks);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const defaults = await getUserExecutionDefaults(userId);
  const parsed = createTaskSchema.safeParse({
    ...automationDefaultsPayload(defaults),
    ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (
    parsed.data.triggerType === "SCHEDULE" &&
    (!parsed.data.cronExpression || !cron.validate(parsed.data.cronExpression))
  ) {
    return NextResponse.json(
      { error: "A valid cronExpression is required when triggerType is SCHEDULE" },
      { status: 400 }
    );
  }

  if (parsed.data.fallbackModel && !parsed.data.model) {
    return NextResponse.json({ error: "A primary model is required when fallbackModel is set" }, { status: 400 });
  }
  if (parsed.data.fallbackModel && parsed.data.fallbackModel === parsed.data.model) {
    return NextResponse.json({ error: "fallbackModel must differ from model" }, { status: 400 });
  }

  const repo = await prisma.repo.findUnique({ where: { id: parsed.data.repoId, userId } });
  if (!repo) return NextResponse.json({ error: "Repo not found" }, { status: 404 });

  const task = await prisma.task.create({ data: parsed.data });
  return NextResponse.json(task, { status: 201 });
}
