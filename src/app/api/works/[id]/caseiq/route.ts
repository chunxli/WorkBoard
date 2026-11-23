import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { caseIqLaunchSchema, type CaseIqLastSession, type CaseIqStatus } from "@/lib/caseiq-options";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { getCaseIqStatus } from "@/lib/caseiq-installation";
import { isTerminalResumeReady, launchNewWorkTerminal, TerminalStartError } from "@/lib/terminal-resume";
import { readNativeSessionBindingSync } from "@/lib/native-session-bindings";
import { nativeBindingCompatibilityKey } from "@/lib/native-session-identity";
import { copilotSessionHasHistory } from "@/lib/copilot-session-compat";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

async function lastCaseIqSession(
  work: { id: string; directoryPath: string; status: string },
  userId: string, status: CaseIqStatus, local: boolean,
): Promise<CaseIqLastSession | null> {
  const run = await prisma.run.findFirst({
    where: { workId: work.id, providerId: "caseiq", experimentVariantId: null,
      OR: [{ engine: null }, { engine: { not: "CASEIQ" } }] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, status: true, createdAt: true, copilotSessionId: true, hostname: true,
      terminalLaunches: { select: { errorMessage: true }, take: 1 },
    },
  });
  if (!run) return null;
  const result: CaseIqLastSession = {
    runId: run.id, status: run.status, createdAt: run.createdAt.toISOString(),
    resumeState: "unavailable", reason: null, configuration: null,
  };
  const active = run.status === "RUNNING" || run.status === "PENDING";
  const recordedIssue = run.terminalLaunches?.some((launch) => Boolean(launch.errorMessage));
  const preparationNotice = recordedIssue
    ? "CaseIQ setup or history synchronization has a recorded error. This Run still reserves the Work. Inspect the native Terminal and Run details; do not launch another session or assume the process has stopped."
    : "CaseIQ native preparation is not yet confirmed. It may be waiting for authentication or input. This Run still reserves the Work; check the native Terminal and Run details before another attempt.";
  if (!local || run.hostname && run.hostname !== hostname()) {
    return { ...result, reason: "Resume this CaseIQ session on its owning Windows host." };
  }
  try {
    const binding = run.copilotSessionId ? readNativeSessionBindingSync(run.copilotSessionId) : null;
    if (!binding || binding.userId !== userId || binding.workId !== work.id) {
      if (active) return { ...result, resumeState: "active", reason: preparationNotice };
      return { ...result, reason: "The private CaseIQ binding is unavailable. Start a new CaseIQ session explicitly." };
    }
    result.configuration = { packs: binding.packs, caseNumber: binding.caseNumber };
    if (work.status === "ARCHIVED") return { ...result, reason: "Restore this Work before resuming CaseIQ." };
    if (active) {
      return { ...result, resumeState: "active", reason: !binding.home || recordedIssue
        ? preparationNotice : "CaseIQ is open or preparing in native Terminal. After closing it, wait for history synchronization or retry this check." };
    }
    if (!status.launchable) return { ...result, reason: status.reason ?? "The current CaseIQ installation is unavailable." };
    if (nativeBindingCompatibilityKey(binding) !== status.compatibilityKey) {
      return { ...result, reason: "The configured CaseIQ installation location changed. Resume requires the original Session's installation paths." };
    }
    if (!binding.home || !await copilotSessionHasHistory(binding.sessionId, binding.home)) {
      return { ...result, reason: "No recorded native session history remains. Start a new CaseIQ Terminal session." };
    }
    if (!await isTerminalResumeReady({ id: run.id, taskId: null, status: run.status, work })) {
      return { ...result, reason: "The native history or source baseline is not ready. Check the Run details before resuming." };
    }
    return { ...result, resumeState: "ready", reason: null };
  } catch (error) {
    console.error("[CaseIQ] Latest session could not be verified.", error);
    if (active) return { ...result, resumeState: "active", reason: "CaseIQ session data could not be verified. This Run still reserves the Work; inspect Run details and the native Terminal before another attempt." };
    return { ...result, reason: "Stored CaseIQ session data could not be verified. Inspect the Run details or start a new session." };
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id } = await params;
  const work = await prisma.work.findFirst({
    where: { id, userId }, select: { id: true, hostname: true, status: true, directoryPath: true },
  });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404, headers });
  const status = await getCaseIqStatus();
  const local = localTerminalAvailable(req.headers.get("host") ?? req.nextUrl.hostname) &&
    (!work.hostname || work.hostname === hostname());
  const lastSession = await lastCaseIqSession(work, userId, status, local);
  return NextResponse.json({
    ...status,
    lastSession,
    launchable: status.launchable && local && work.status !== "ARCHIVED",
    reason: !local ? "Native CaseIQ Terminal is only available on the owning Windows host."
      : work.status === "ARCHIVED" ? "Restore this Work before opening CaseIQ." : status.reason,
  }, { headers });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!localTerminalAvailable(req.headers.get("host") ?? req.nextUrl.hostname)) {
    return NextResponse.json({ error: "Native CaseIQ Terminal is only available on this Windows host." }, { status: 403 });
  }
  if (req.headers.get("origin") && req.headers.get("origin") !== req.nextUrl.origin) {
    return NextResponse.json({ error: "Cross-origin terminal launch is not allowed." }, { status: 403 });
  }
  const input = caseIqLaunchSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid CaseIQ options." }, { status: 400 });
  const { id } = await params;
  try {
    return NextResponse.json(await launchNewWorkTerminal(userId, id, input.data), { status: 202 });
  } catch (error) {
    if (error instanceof CaseIqIntegrationError || error instanceof TerminalStartError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[CaseIQ] Terminal launch failed.", error);
    return NextResponse.json({ error: "CaseIQ Terminal could not be opened. Check the native environment and server logs." }, { status: 500 });
  }
}
