import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ownedRunWhere } from "@/lib/run-access";
import { getSessionUserId } from "@/lib/session";
import {
  launchTerminalResume,
  TerminalResumeInProgressError,
  TerminalResumeNotReadyError,
} from "@/lib/terminal-resume";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { CopilotSessionInUseError } from "@/lib/copilot-session-compat";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!localTerminalAvailable(req.nextUrl.hostname)) {
    return NextResponse.json(
      { error: "Local terminal launch is only available from this Windows host" },
      { status: 403 }
    );
  }

  const { id } = await params;
  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    select: { id: true, workId: true, taskId: true, copilotSessionId: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if ((!run.workId && !run.taskId) || !run.copilotSessionId) {
    return NextResponse.json({ error: "Run has no resumable Copilot session" }, { status: 409 });
  }

  try {
    const launched = await launchTerminalResume(run.id);
    return NextResponse.json(launched, { status: 202 });
  } catch (error) {
    if (
      error instanceof CopilotSessionInUseError ||
      error instanceof TerminalResumeInProgressError ||
      error instanceof TerminalResumeNotReadyError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to open Windows Terminal" },
      { status: 500 }
    );
  }
}