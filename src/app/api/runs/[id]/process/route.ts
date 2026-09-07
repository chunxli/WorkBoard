import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRunProcessStats } from "@/lib/copilot-runner";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    select: {
      pid: true,
      command: true,
      cpuTimeMs: true,
      peakMemoryMb: true,
      agent: true,
      model: true,
      fallbackModel: true,
      contextTier: true,
      reasoningEffort: true,
      permissionMode: true,
      timeoutSeconds: true,
      task: {
        select: {
          agent: true,
          model: true,
          fallbackModel: true,
          contextTier: true,
          reasoningEffort: true,
          permissionMode: true,
          timeoutSeconds: true,
        },
      },
    },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Prefer the live in-memory sample (updated every few seconds while the process runs);
  // fall back to the last value persisted to the DB once the process has exited.
  const live = getRunProcessStats(id);
  return NextResponse.json({
    pid: run.pid,
    command: run.command,
    cpuTimeMs: live?.cpuTimeMs ?? run.cpuTimeMs,
    memoryMb: live?.memoryMb ?? run.peakMemoryMb,
    agent: run.agent ?? run.task?.agent,
    model: run.model ?? run.task?.model,
    fallbackModel: run.fallbackModel ?? run.task?.fallbackModel,
    contextTier: run.contextTier ?? run.task?.contextTier,
    reasoningEffort: run.reasoningEffort ?? run.task?.reasoningEffort,
    permissionMode: run.permissionMode ?? run.task?.permissionMode,
    timeoutLabel: run.task
      ? `${run.timeoutSeconds ?? run.task.timeoutSeconds}s`
      : run.timeoutSeconds
        ? `${run.timeoutSeconds}s`
        : "None",
  });
}
