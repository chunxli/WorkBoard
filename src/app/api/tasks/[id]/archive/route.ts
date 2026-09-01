import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";

async function ownedTask(id: string, userId: string) {
  return prisma.task.findFirst({ where: { id, repo: { userId } }, select: { id: true } });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await ownedTask(id, userId))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const task = await prisma.task.update({
    where: { id },
    data: { archivedAt: new Date(), enabled: false },
  });
  return NextResponse.json(task);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await ownedTask(id, userId))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const task = await prisma.task.update({ where: { id }, data: { archivedAt: null } });
  return NextResponse.json(task);
}