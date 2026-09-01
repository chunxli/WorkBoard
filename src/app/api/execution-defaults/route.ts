import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { executionDefaultsSchema } from "@/lib/validation";
import {
  executionDefaultsPayload,
  normalizeExecutionDefaults,
} from "@/lib/execution-defaults";
import { getUserExecutionDefaults } from "@/lib/user-execution-defaults";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await getUserExecutionDefaults(userId));
}

export async function PUT(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = executionDefaultsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = executionDefaultsPayload(normalizeExecutionDefaults(parsed.data));
  const stored = await prisma.userExecutionSettings.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return NextResponse.json(normalizeExecutionDefaults(stored));
}