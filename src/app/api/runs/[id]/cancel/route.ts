import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cancelRun } from "@/lib/copilot-runner";
import { cancelSdkRun } from "@/lib/copilot-sdk-runner";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";
import { finalizeCancelledWorkRun } from "@/lib/work-executor";
import { finalizeAutomationRun } from "@/lib/task-executor";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let run = await prisma.run.findFirst({ where: ownedRunWhere(userId, id) });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (run.status === "RUNNING") {
    if (run.trigger === "TERMINAL_RESUME") {
      return NextResponse.json(
        { error: "Close the external terminal, then synchronize the session" },
        { status: 409 }
      );
    }
    const killed = run.engine === "SDK" ? cancelSdkRun(id) : cancelRun(id);
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
        const killed = run.engine === "SDK" ? cancelSdkRun(id) : cancelRun(id);
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
