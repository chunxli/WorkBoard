import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { createWorkPathShortcutSchema } from "@/lib/validation";
import { resolveWorkDirectory } from "@/lib/work-files";
import { resolveExplorerDirectory } from "@/lib/local-explorer";

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = createWorkPathShortcutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const rootPath = await resolveExplorerDirectory(
      resolveWorkDirectory(parsed.data.rootPath)
    );
    const shortcut = await prisma.workPathShortcut.create({
      data: {
        userId,
        label: parsed.data.label,
        rootPath,
      },
    });
    return NextResponse.json(shortcut, { status: 201 });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return NextResponse.json(
      { error: code === "P2002" ? "This path is already saved" : error instanceof Error ? error.message : "Failed" },
      { status: code === "P2002" ? 409 : 400 }
    );
  }
}