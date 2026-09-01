import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { updateWorkSchema } from "@/lib/validation";
import { updateWorkManifestMetadata } from "@/lib/work-files";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const work = await prisma.work.findFirst({
    where: { id, userId },
    include: {
      sourceRepo: { select: { id: true, name: true } },
      tasks: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!work) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(work);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.work.findFirst({ where: { id, userId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = updateWorkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.status === "ARCHIVED") {
    const activeRuns = await prisma.run.count({
      where: { workId: existing.id, status: { in: ["PENDING", "RUNNING"] } },
    });
    if (activeRuns > 0) {
      return NextResponse.json(
        { error: "Wait for active runs to finish before archiving this Work" },
        { status: 409 }
      );
    }
  }

  try {
    if (parsed.data.name || parsed.data.status) {
      await updateWorkManifestMetadata(existing, {
        name: parsed.data.name,
        status: parsed.data.status,
      });
    }
    const work = await prisma.work.update({
      where: { id },
      data: {
        ...parsed.data,
        ...(parsed.data.status === "ARCHIVED"
          ? { archivedAt: existing.archivedAt ?? new Date() }
          : parsed.data.status
            ? { archivedAt: null }
            : {}),
      },
    });
    return NextResponse.json(work);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update Work" },
      { status: 400 }
    );
  }
}