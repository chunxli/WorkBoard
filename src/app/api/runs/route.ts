import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const runs = await prisma.run.findMany({
    where: ownedRunWhere(userId),
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      task: { select: { id: true, name: true, repoId: true } },
      work: { select: { id: true, name: true } },
    },
  });
  return NextResponse.json(runs);
}
