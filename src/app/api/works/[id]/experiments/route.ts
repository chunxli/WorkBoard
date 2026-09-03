import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAndRunExperiment } from "@/lib/experiment-service";
import { getSessionUserId } from "@/lib/session";
import { createExperimentSchema } from "@/lib/validation";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const parsed = createExperimentSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const experiment = await withRunStartLock([`work:${id}`], async () => {
      const work = await prisma.work.findFirst({ where: { id, userId } });
      if (!work) throw new ExperimentStartError("Work not found", 404);
      if (work.status === "ARCHIVED") {
        throw new ExperimentStartError("Restore this Work before running an experiment");
      }
      const activeRun = await prisma.run.findFirst({
        where: { workId: work.id, status: { in: ["PENDING", "RUNNING"] } },
        select: { id: true },
      });
      if (activeRun) {
        throw new ExperimentStartError("Wait for active Work Runs to finish");
      }
      return createAndRunExperiment({ workId: work.id, ...parsed.data });
    });
    return NextResponse.json(experiment, { status: 202 });
  } catch (error) {
    if (error instanceof ExperimentStartError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof RunStartInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create experiment" },
      { status: 400 }
    );
  }
}

class ExperimentStartError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "ExperimentStartError";
  }
}