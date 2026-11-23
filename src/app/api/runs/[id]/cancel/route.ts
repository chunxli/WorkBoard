import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cancelRun, isNativeCopilotRunActive } from "@/lib/copilot-runner";
import { cancelSdkRun } from "@/lib/copilot-sdk-runner";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";
import { cancelPendingCaseIqWorkRun, finalizeCancelledWorkRun } from "@/lib/work-executor";
import { finalizeAutomationRun } from "@/lib/task-executor";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { CopilotProcessStopError } from "@/lib/copilot-process";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { requestInterruptedCaseIqCancellation } from "@/lib/caseiq-run-lifecycle";
import { isCaseIqWebRun } from "@/lib/runtime-provider";

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try { return await cancelRequest(context); }
  catch (error) {
    if (error instanceof CaseIqIntegrationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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
    return cancelRunningRun(run);
  }

  if (run.status === "PENDING") {
    if (run.workId && !run.taskId && isCaseIqWebRun(run)) {
      if (await cancelPendingCaseIqWorkRun(id, "Run was cancelled before it started.")) {
        return NextResponse.json({ ok: true });
      }
      run = await prisma.run.findFirst({ where: ownedRunWhere(userId, id) });
      if (run?.status === "RUNNING") return cancelRunningRun(run);
      if (run?.status === "CANCELLED") return NextResponse.json({ ok: true });
      return NextResponse.json({ error: "Run is not cancellable" }, { status: 400 });
    }
    const cancelled = await prisma.run.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    if (cancelled.count === 0) {
      run = await prisma.run.findFirst({ where: ownedRunWhere(userId, id) });
      if (run?.status === "RUNNING") return cancelRunningRun(run);
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

async function cancelRunningRun(run: NonNullable<Awaited<ReturnType<typeof prisma.run.findFirst>>>) {
  if (isCaseIqWebRun(run)) {
    if (run.hostname !== hostname()) {
      throw new CaseIqIntegrationError("Cancel this Run on its verified owning Windows host.", 409);
    }
    if (!(isNativeCopilotRunActive(run.id) && await cancelRun(run.id))) {
      try { await requestInterruptedCaseIqCancellation(run); }
      catch (error) {
        if (error instanceof CaseIqIntegrationError) throw error;
        console.error("[CaseIQ] Interrupted Run cancellation could not be requested.", run.id, error instanceof Error ? error.name : error);
        throw new CaseIqIntegrationError("CaseIQ cancellation could not be requested. The Work remains reserved; inspect the original host and private Run diagnostics.", 409);
      }
    }
    // The Run coordinator still owns the final status and artifacts.
    return NextResponse.json({ ok: true, pending: true }, { status: 202 });
  }
  const killed = run.engine === "SDK" ? await cancelSdkRun(run.id) : await cancelRun(run.id);
  if (!killed) {
    await prisma.run.update({ where: { id: run.id }, data: { status: "CANCELLED" } });
    if (run.taskId) await finalizeAutomationRun(run.id, "CANCELLED", "Run was cancelled.");
    else if (run.workId) await finalizeCancelledWorkRun(run.id);
  }
  return NextResponse.json({ ok: true });
}
