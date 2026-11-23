import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getRunDiff } from "@/lib/git-safety";
import { getSessionUserId } from "@/lib/session";
import { ownedRunWhere } from "@/lib/run-access";
import { readRunLogTail } from "@/lib/run-artifacts";
import { getRunStatusSnapshot } from "@/lib/run-status";
import { getCaseIqStartup } from "@/lib/caseiq-startup-state";
import { assertPairedRunArtifactLocation } from "@/lib/work-pair-directories";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });

  const { id } = await params;
  if (req.nextUrl.searchParams.get("view") === "startup") {
    const run = await prisma.run.findFirst({
      where: ownedRunWhere(userId, id),
      select: {
        id: true, status: true, engine: true, providerId: true, hostname: true,
        startedAt: true, createdAt: true,
      },
    });
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
    if (run.engine !== "CASEIQ" || run.providerId !== "caseiq") {
      return NextResponse.json({ error: "Startup monitoring is only available for CaseIQ web Runs." }, { status: 400, headers });
    }
    const local = run.hostname === hostname();
    const active = ["PENDING", "RUNNING"].includes(run.status);
    const startup = active && local ? getCaseIqStartup(run.id) : null;
    return NextResponse.json({
      runId: run.id, status: run.status, startedAt: (run.startedAt ?? run.createdAt).toISOString(),
      startup,
      unavailableReason: !active || startup ? null : !local
        ? "Live startup state is only available on the Run's verified owning host."
        : run.status === "PENDING" ? null
          : "No live startup marker is available. The Run may already be executing; inspect its output rather than assuming it has not started.",
    }, { headers });
  }
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
      select: { id: true, status: true, logPath: true, outputDir: true, engine: true, providerId: true,
        executionPath: true, copilotSessionId: true, work: { select: { directoryPath: true, sessionPair: true } } },
    });
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
    if (run.work?.sessionPair) {
      try { await assertPairedRunArtifactLocation(run.work, run); }
      catch { return NextResponse.json({ error: "The original paired Run output could not be verified." }, { status: 409, headers }); }
    }
    const log = run.logPath ? await readRunLogTail(run.logPath).catch(() => "") : "";
    return NextResponse.json({ status: run.status, log }, { headers });
  }

  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    include: { task: { include: { repo: true } }, work: { include: { sessionPair: true } } },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  if (run.work?.sessionPair) {
    try { await assertPairedRunArtifactLocation(run.work, run); }
    catch { return NextResponse.json({ error: "The original paired Run output could not be verified." }, { status: 409, headers }); }
  }

  const log = run.logPath ? await readFile(run.logPath, "utf8").catch(() => "") : "";

  const diff = run.outputDir
    ? await readFile(path.join(run.outputDir, "diff.patch"), "utf8").catch(() => "")
    : await getRunDiff(run);

  return NextResponse.json({ ...run, log, diff }, { headers });
}
