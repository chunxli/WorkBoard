import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getRunDiff } from "@/lib/git-safety";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";
import { readRunLogTail } from "@/lib/run-artifacts";
import { getRunStatusSnapshot } from "@/lib/run-status";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });

  const { id } = await params;
  if (req.nextUrl.searchParams.get("view") === "status") {
    const run = await prisma.run.findFirst({
      where: ownedRunWhere(userId, id),
      select: {
        id: true, status: true, trigger: true, copilotSessionId: true, hostname: true, createdAt: true,
        terminalLaunches: { select: { id: true, errorMessage: true }, take: 1 },
        resumedRuns: { select: { id: true }, take: 1 },
      },
    });
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
    return NextResponse.json(await getRunStatusSnapshot(run), { headers });
  }
  if (req.nextUrl.searchParams.get("view") === "live") {
    const run = await prisma.run.findFirst({
      where: ownedRunWhere(userId, id),
      select: { status: true, logPath: true },
    });
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
    const log = run.logPath ? await readRunLogTail(run.logPath).catch(() => "") : "";
    return NextResponse.json({ status: run.status, log }, { headers });
  }

  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    include: { task: { include: { repo: true } }, work: true },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404, headers });

  const log = run.logPath ? await readFile(run.logPath, "utf8").catch(() => "") : "";

  const diff = run.outputDir
    ? await readFile(path.join(run.outputDir, "diff.patch"), "utf8").catch(() => "")
    : await getRunDiff(run);

  return NextResponse.json({ ...run, log, diff }, { headers });
}
