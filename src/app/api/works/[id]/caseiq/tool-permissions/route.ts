import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { RunStartInProgressError } from "@/lib/run-start-lock";
import { caseIqRequestedToolNamesSchema, caseIqSupportIqToolNameSchema } from "@/lib/caseiq-options";
import {
  approveCaseIqRequestedTools, getCaseIqToolPermissionStatus, setCaseIqAutomaticToolApproval, setCaseIqToolPermission,
} from "@/lib/caseiq-tool-permissions";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const querySchema = z.object({ runId: z.string().min(1).max(128) });
const actionSchema = z.union([
  querySchema.extend({ toolName: caseIqSupportIqToolNameSchema, approved: z.boolean() }).strict(),
  querySchema.extend({ action: z.literal("approve-requested"), toolNames: caseIqRequestedToolNamesSchema }).strict(),
  querySchema.extend({ action: z.literal("set-automatic"), enabled: z.boolean() }).strict(),
]);

function failure(error: unknown) {
  if (error instanceof CaseIqIntegrationError || error instanceof RunStartInProgressError) {
    return NextResponse.json({ error: error.message }, { status: error instanceof CaseIqIntegrationError ? error.status : 409, headers });
  }
  console.error("[CaseIQ] Tool approval request failed.", error);
  return NextResponse.json({ error: "CaseIQ tool approvals could not be checked or saved. Inspect local diagnostics." }, { status: 500, headers });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const input = querySchema.safeParse({ runId: request.nextUrl.searchParams.get("runId") });
  if (!input.success) return NextResponse.json({ error: "A valid CaseIQ Run ID is required." }, { status: 400, headers });
  try {
    return NextResponse.json(await getCaseIqToolPermissionStatus(userId, (await params).id, input.data.runId,
      localTerminalAvailable(request.headers.get("host") ?? request.nextUrl.hostname)), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const origin = request.headers.get("origin");
  const expectedOrigin = `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: "Cross-origin tool approval is not allowed." }, { status: 403, headers });
  if (!localTerminalAvailable(request.headers.get("host") ?? request.nextUrl.hostname)) {
    return NextResponse.json({ error: "Change tool approvals on the Work's local Windows host." }, { status: 403, headers });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Tool approval requires application/json." }, { status: 415, headers });
  }
  const input = actionSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid CaseIQ tool approval request." }, { status: 400, headers });
  try {
    const workId = (await params).id;
    const decision = input.data;
    const status = "action" in decision
      ? decision.action === "approve-requested"
        ? await approveCaseIqRequestedTools(userId, workId, decision.runId, decision.toolNames)
        : await setCaseIqAutomaticToolApproval(userId, workId, decision.runId, decision.enabled)
      : await setCaseIqToolPermission(userId, workId, decision.runId, decision.toolName, decision.approved);
    return NextResponse.json(status, { headers });
  } catch (error) { return failure(error); }
}
