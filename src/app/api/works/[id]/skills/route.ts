import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { discoverLocalSkills, discoverProjectSkills } from "@/lib/skill-discovery";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const work = await prisma.work.findFirst({ where: { id, userId } });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404 });

  try {
    const localPath = req.nextUrl.searchParams.get("localPath");
    const skills = localPath
      ? await discoverLocalSkills(localPath)
      : await discoverProjectSkills(work.directoryPath);
    return NextResponse.json(skills);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to discover Skills" },
      { status: 400 }
    );
  }
}