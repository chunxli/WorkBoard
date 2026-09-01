import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAndRunExperiment } from "@/lib/experiment-service";
import { getSessionUserId } from "@/lib/session";
import { createExperimentSchema } from "@/lib/validation";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const work = await prisma.work.findFirst({ where: { id, userId } });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404 });
  if (work.status === "ARCHIVED") {
    return NextResponse.json({ error: "Restore this Work before running an experiment" }, { status: 409 });
  }

  const parsed = createExperimentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const experiment = await createAndRunExperiment({ workId: work.id, ...parsed.data });
    return NextResponse.json(experiment, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create experiment" },
      { status: 400 }
    );
  }
}