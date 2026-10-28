import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { getManagedRuntime } from "@/lib/managed-runtime";
import { RuntimeControlError, runtimeActionSchema } from "@/lib/managed-runtime-types";
import { isTerminalRunTrigger } from "@/lib/terminal-run";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const querySchema = z.object({ runId: z.string().min(1).max(128) });

async function resolveRuntime(workId: string, runId: string, userId: string, expectedSessionId?: string) {
  const work = await prisma.work.findFirst({
    where: { id: workId, userId }, select: { id: true, hostname: true, status: true },
  });
  if (!work) throw new RuntimeControlError(404, "Work not found.");
  const run = await prisma.run.findFirst({
    where: { id: runId, workId, experimentVariantId: null },
    select: { id: true, hostname: true, status: true, trigger: true, engine: true, copilotSessionId: true },
  });
  if (!run || expectedSessionId !== undefined && expectedSessionId !== run.copilotSessionId) {
    throw new RuntimeControlError(409, "The selected Run and session no longer match.");
  }
  if (run.hostname && run.hostname !== hostname() || work.hostname && work.hostname !== hostname()) {
    throw new RuntimeControlError(409, "This Run belongs to another machine.");
  }
  if (isTerminalRunTrigger(run.trigger)) {
    return { runtime: null, reason: "This session is owned by Terminal. Answer questions and sign in there." };
  }
  if (run.engine === "CLI") {
    return { runtime: null, reason: "This Run uses the native non-interactive Copilot CLI. SDK live controls and Steering are unavailable. Wait for the Run to finish, then send Follow Up." };
  }
  if (run.status === "PENDING" && work.status !== "ARCHIVED") {
    return { runtime: null, reason: "This Run is queued or starting. Live runtime controls will appear when its local session is ready." };
  }
  if (work.status === "ARCHIVED" || run.status !== "RUNNING" || run.engine !== "SDK") {
    return { runtime: null, reason: "Live runtime controls are available only during a managed SDK Run." };
  }
  if (!run.hostname) {
    return { runtime: null, reason: "This Run's execution host has not been confirmed yet. Waiting for local session startup." };
  }
  if (!run.copilotSessionId) {
    return { runtime: null, reason: "Copilot is starting. Waiting for the Run's session to be assigned." };
  }
  const runtime = getManagedRuntime(run.id);
  if (!runtime || runtime.sessionId !== run.copilotSessionId) {
    return { runtime: null, reason: "No live runtime bridge is available. Start a new Run after updating Work Board." };
  }
  return { runtime, reason: null };
}

function failure(error: unknown) {
  if (error instanceof RuntimeControlError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers });
  }
  console.error("[Work Board] Runtime control request failed.");
  return NextResponse.json({ error: "Runtime controls failed. Check the local Work Board diagnostics." }, { status: 500, headers });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const parsed = querySchema.safeParse({ runId: request.nextUrl.searchParams.get("runId") });
  if (!parsed.success) return NextResponse.json({ error: "A valid Run ID is required." }, { status: 400, headers });
  try {
    const { runtime, reason } = await resolveRuntime((await params).id, parsed.data.runId, userId);
    return NextResponse.json(runtime ? { available: true, state: await runtime.snapshot() } : { available: false, reason }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const origin = request.headers.get("origin");
  const requestOrigin = `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  if (origin && origin !== requestOrigin) {
    return NextResponse.json({ error: "Cross-origin runtime actions are not allowed." }, { status: 403, headers });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Runtime actions require application/json." }, { status: 415, headers });
  }
  const parsed = runtimeActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid runtime action." }, { status: 400, headers });
  try {
    const input = parsed.data;
    const { runtime, reason } = await resolveRuntime((await params).id, input.runId, userId, input.sessionId);
    if (!runtime) throw new RuntimeControlError(409, reason ?? "The session is unavailable.");
    if (input.action === "reply") {
      runtime.reply(input.reply);
      return NextResponse.json({ accepted: true }, { headers });
    }
    return NextResponse.json(await runtime.mcpAction(input.action, "serverName" in input ? input.serverName : undefined), { headers });
  } catch (error) { return failure(error); }
}
