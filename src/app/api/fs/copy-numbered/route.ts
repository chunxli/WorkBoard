import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { copyWorkToNumberedSibling, WorkFileError } from "@/lib/work-files";

const requestSchema = z.object({ path: z.string().trim().min(1).max(2000) }).strict();

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!localTerminalAvailable(req.nextUrl.hostname)) {
    return NextResponse.json(
      { error: "Local folder copying is only available from this Windows host" },
      { status: 403 }
    );
  }

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const destinationPath = await copyWorkToNumberedSibling(parsed.data.path);
    return NextResponse.json({ destinationPath }, { status: 201 });
  } catch (error) {
    const status = error instanceof WorkFileError && error.code === "copy_name_exhausted" ? 409 : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to copy folder" },
      { status }
    );
  }
}