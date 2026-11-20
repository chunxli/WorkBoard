import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { RunStartInProgressError } from "@/lib/run-start-lock";
import { WorkAttachmentError } from "@/lib/work-attachments";
import { WorkPairError } from "@/lib/work-pair-directories";
import { PairedAdmissionRejectedError, sendPairedFollowUp, startPairedWork } from "@/lib/work-pair-execution";
import { pairedWorkRequest } from "@/lib/work-session-pair";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const host = request.headers.get("host") ?? request.nextUrl.host;
  const origin = request.headers.get("origin");
  if ((origin && origin !== `${request.nextUrl.protocol}//${host}`) || !localTerminalAvailable(host)) {
    return NextResponse.json({ error: "Paired Sessions require the local Windows Work Board." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Paired Sessions require application/json." }, { status: 415 });
  }
  const parsed = pairedWorkRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid paired Session request." }, { status: 400 });
  const { id } = await params;
  try {
    const result = parsed.data.action === "start" ? await startPairedWork(userId, id) : await sendPairedFollowUp(userId, id, parsed.data);
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof PairedAdmissionRejectedError) {
      return NextResponse.json({ error: error.message, admissionRejected: true }, { status: error.status });
    }
    if (error instanceof WorkPairError || error instanceof CaseIqIntegrationError || error instanceof WorkAttachmentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof RunStartInProgressError) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("[Work Board] Paired Session admission failed.", error);
    return NextResponse.json({ error: "Could not confirm admission. Retry the same request; do not send a new one." }, { status: 500 });
  }
}
