import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto";
import { syncTerminalRun, TerminalSyncInProgressError } from "@/lib/terminal-resume";
import { CopilotSessionInUseError } from "@/lib/copilot-session-compat";

const callbackSchema = z.object({ exitCode: z.number().int().min(-1).max(2147483647) });

export async function POST(req: NextRequest) {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = authorization.slice("Bearer ".length).trim();
  const launch = await prisma.terminalLaunch.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!launch || launch.expiresAt <= new Date()) {
    return NextResponse.json({ error: "Invalid or expired callback" }, { status: 401 });
  }
  if (launch.status === "COMPLETED") {
    return NextResponse.json({ ok: true, alreadySynced: true });
  }

  const parsed = callbackSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await syncTerminalRun(launch.runId, parsed.data.exitCode);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CopilotSessionInUseError || error instanceof TerminalSyncInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Session synchronization failed" }, { status: 500 });
  }
}