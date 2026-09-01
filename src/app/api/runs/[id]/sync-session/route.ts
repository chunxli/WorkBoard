import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ownedRunWhere } from "@/lib/run-access";
import { getSessionUserId } from "@/lib/session";
import { syncTerminalRun } from "@/lib/terminal-resume";
import { CopilotSessionInUseError } from "@/lib/copilot-session-compat";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    select: { id: true, trigger: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.trigger !== "TERMINAL_RESUME") {
    return NextResponse.json({ error: "Run is not a terminal resume" }, { status: 409 });
  }

  try {
    await syncTerminalRun(run.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CopilotSessionInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to synchronize session" },
      { status: 500 }
    );
  }
}