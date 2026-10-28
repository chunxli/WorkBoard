import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cancelRun } from "@/lib/copilot-runner";
import { cancelSdkRun } from "@/lib/copilot-sdk-runner";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";
import { finalizeCancelledWorkRun } from "@/lib/work-executor";
import { finalizeAutomationRun } from "@/lib/task-executor";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { CopilotProcessStopError } from "@/lib/copilot-process";

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try { return await cancelRequest(context); }
  catch (error) {
    if (!(error instanceof CopilotProcessStopError)) throw error;
    console.error("[Work Board] Native CLI cancellation failed.", error);
    return NextResponse.json({ error: "Could not stop the native CLI process. It may still be running; retry cancellation or inspect local diagnostics." }, { status: 500 });
  }
}

async function cancelRequest(
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let run = await prisma.run.findFirst({ where: ownedRunWhere(userId, id) });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (isTerminalRunTrigger(run.trigger) && (run.status === "PENDING" || run.status === "RUNNING")) {
    return NextResponse.json(
      { error: "External Terminal sessions cannot be cancelled here. Close Copilot in Terminal; WorkBoard synchronizes its history automatically." },
      { status: 409 }
    );
  }
  if (run.status === "RUNNING") {
    const killed = await cancelActiveRun(run);
    if (!killed) {
      await prisma.run.update({ where: { id }, data: { status: "CANCELLED" } });
      if (run.taskId) await finalizeAutomationRun(id, "CANCELLED", "Run was cancelled.");
      else if (run.workId) await finalizeCancelledWorkRun(id);
    }
    return NextResponse.json({ ok: true });
  }

  if (run.status === "PENDING") {
    const cancelled = await prisma.run.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    if (cancelled.count === 0) {
      run = await prisma.run.findFirst({ where: ownedRunWhere(userId, id) });
      if (run?.status === "RUNNING") {
        const killed = await cancelActiveRun(run);
        if (!killed) {
          await prisma.run.update({ where: { id }, data: { status: "CANCELLED" } });
          if (run.taskId) await finalizeAutomationRun(id, "CANCELLED", "Run was cancelled.");
          else if (run.workId) await finalizeCancelledWorkRun(id);
        }

      }
      return NextResponse.json({ ok: true });
    }
    if (run.taskId) {
      await finalizeAutomationRun(id, "CANCELLED", "Run was cancelled before it started.");
    } else if (run.workId) {
      await finalizeCancelledWorkRun(id, "Run was cancelled before it started.");
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Run is not cancellable" }, { status: 400 });
}

async function cancelActiveRun(run: NonNullable<Awaited<ReturnType<typeof prisma.run.findFirst>>>) {
  if (run.engine === "SDK") return cancelSdkRun(run.id);
  return cancelRun(run.id);
}
