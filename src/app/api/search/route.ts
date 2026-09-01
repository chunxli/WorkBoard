import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ works: [], repos: [], tasks: [], runs: [] });
  }

  const [works, repos, tasks, runs] = await Promise.all([
    prisma.work.findMany({
      where: { name: { contains: q }, userId, status: { not: "ARCHIVED" } },
      take: 5,
      select: { id: true, name: true },
    }),
    prisma.repo.findMany({
      where: { name: { contains: q }, userId },
      take: 5,
      select: { id: true, name: true },
    }),
    prisma.task.findMany({
      where: { name: { contains: q }, archivedAt: null, repo: { userId } },
      take: 5,
      select: { id: true, name: true },
    }),
    prisma.run.findMany({
      where: {
        id: { contains: q },
        OR: [
          { work: { userId, status: { not: "ARCHIVED" } } },
          { task: { archivedAt: null, repo: { userId } } },
        ],
      },
      take: 5,
      select: {
        id: true,
        status: true,
        task: { select: { name: true } },
        work: { select: { name: true } },
      },
    }),
  ]);

  return NextResponse.json({ works, repos, tasks, runs });
}

