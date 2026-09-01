import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ownedRunWhere } from "@/lib/run-access";
import { getSessionUserId } from "@/lib/session";

const ARTIFACTS = {
  "result.md": "text/markdown; charset=utf-8",
  "transcript.jsonl": "application/x-ndjson; charset=utf-8",
  "diff.patch": "text/x-diff; charset=utf-8",
  "run.json": "application/json; charset=utf-8",
  "stdout.log": "text/plain; charset=utf-8",
  "stderr.log": "text/plain; charset=utf-8",
} as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, name } = await params;
  if (!(name in ARTIFACTS)) {
    return NextResponse.json({ error: "Unknown artifact" }, { status: 404 });
  }

  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    select: { outputDir: true },
  });
  if (!run?.outputDir) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });

  try {
    const content = await readFile(path.join(run.outputDir, name));
    return new Response(content, {
      headers: {
        "Content-Type": ARTIFACTS[name as keyof typeof ARTIFACTS],
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }
}