import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { openDirectoryInExplorer } from "@/lib/local-explorer";

const requestSchema = z.object({ path: z.string().trim().min(1).max(2000) }).strict();

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!localTerminalAvailable(req.nextUrl.hostname)) {
    return NextResponse.json(
      { error: "Windows Explorer can only be opened from this local Windows host" },
      { status: 403 }
    );
  }
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    await openDirectoryInExplorer(parsed.data.path);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to open Explorer" },
      { status: 400 }
    );
  }
}