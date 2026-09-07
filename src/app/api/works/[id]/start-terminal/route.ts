import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import {
  launchNewWorkTerminal,
  TerminalStartError,
} from "@/lib/terminal-resume";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!localTerminalAvailable(req.headers.get("host") ?? req.nextUrl.hostname)) {
    return NextResponse.json(
      { error: "Local terminal launch is only available from this Windows host" },
      { status: 403 }
    );
  }

  const { id } = await params;
  try {
    return NextResponse.json(
      await launchNewWorkTerminal(userId, id),
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof TerminalStartError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to open Windows Terminal" },
      { status: 500 }
    );
  }
}
