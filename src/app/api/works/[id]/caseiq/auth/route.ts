import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { RunStartInProgressError } from "@/lib/run-start-lock";
import {
  cleanCaseIqStaleCredentials,
  getCaseIqAuthenticationStatus,
  startCaseIqAuthentication,
  stopCaseIqRunsAndStartAuthentication,
} from "@/lib/caseiq-authentication";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const querySchema = z.object({ runId: z.string().min(1).max(128) });
const actionSchema = z.union([
  querySchema.extend({
    action: z.literal("clean-credentials"),
  }).strict(),
  querySchema.extend({
    action: z.literal("stop-and-sign-in"),
    requestId: z.uuid(),
    trustWorkFolder: z.boolean().default(false),
  }).strict(),
  querySchema.extend({
    requestId: z.uuid(), trustWorkFolder: z.boolean().default(false), automatic: z.boolean().default(false),
  }).strict(),
]);

function failure(error: unknown) {
  if (error instanceof CaseIqIntegrationError || error instanceof RunStartInProgressError) {
    return NextResponse.json({ error: error.message }, { status: error instanceof CaseIqIntegrationError ? error.status : 409, headers });
  }
  console.error("[CaseIQ] Authentication request failed.", error);
  return NextResponse.json({ error: "CaseIQ authentication failed. Check the original window and local diagnostics." }, { status: 500, headers });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const input = querySchema.safeParse({ runId: request.nextUrl.searchParams.get("runId") });
  if (!input.success) return NextResponse.json({ error: "A valid CaseIQ Run ID is required." }, { status: 400, headers });
  try {
    return NextResponse.json(await getCaseIqAuthenticationStatus(userId, (await params).id, input.data.runId,
      localTerminalAvailable(request.headers.get("host") ?? request.nextUrl.hostname)), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const origin = request.headers.get("origin");
  const expectedOrigin = `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  if (origin && origin !== expectedOrigin) return NextResponse.json({ error: "Cross-origin sign-in is not allowed." }, { status: 403, headers });
  if (!localTerminalAvailable(request.headers.get("host") ?? request.nextUrl.hostname)) {
    return NextResponse.json({ error: "Open sign-in on the Work's local Windows host." }, { status: 403, headers });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Sign-in requires application/json." }, { status: 415, headers });
  }
  const input = actionSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid CaseIQ authentication request." }, { status: 400, headers });
  try {
    const workId = (await params).id;
    const payload = input.data;
    if ("action" in payload) {
      if (payload.action === "clean-credentials") {
        return NextResponse.json(await cleanCaseIqStaleCredentials(userId, workId, payload.runId), { status: 200, headers });
      }
      return NextResponse.json(
        await stopCaseIqRunsAndStartAuthentication(userId, workId, payload.runId, payload.requestId, payload.trustWorkFolder),
        { status: 202, headers }
      );
    }
    return NextResponse.json(await startCaseIqAuthentication(userId, workId, payload.runId,
      payload.requestId, payload.trustWorkFolder, payload.automatic), { status: 202, headers });
  } catch (error) { return failure(error); }
}
