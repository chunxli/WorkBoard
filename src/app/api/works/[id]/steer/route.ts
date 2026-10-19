import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { getManagedSessionController } from "@/lib/managed-session-controller";
import { appendWorkRunSteeringArtifact, getWorkRunArtifactPaths } from "@/lib/run-artifacts";
import { ensureSteeringPrompt } from "@/lib/work-executor";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import {
  getSteeringAvailabilityReason,
  processWorkSteeringMessage,
  SteeringRequestError,
  type WorkSteeringMessageRecord,
} from "@/lib/work-steering";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const requestSchema = z.object({
  runId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  requestId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(100_000),
}).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400, headers });
  }
  const { id: workId } = await params;
  const work = await prisma.work.findFirst({
    where: { id: workId, userId },
    select: {
      id: true, directoryPath: true, promptFileName: true, status: true, hostname: true,
    },
  });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404, headers });

  const run = await prisma.run.findFirst({
    where: { id: parsed.data.runId, workId, experimentVariantId: null },
    select: {
      id: true, status: true, trigger: true, engine: true, hostname: true,
      copilotSessionId: true, createdAt: true,
    },
  });
  if (!run || !run.copilotSessionId || run.copilotSessionId !== parsed.data.sessionId) {
    return NextResponse.json({ error: "The selected Run and session no longer match." }, { status: 409, headers });
  }
  if (
    run.hostname !== hostname() ||
    work.hostname !== null && work.hostname !== hostname()
  ) {
    return NextResponse.json({ error: "This Run belongs to another machine." }, { status: 409, headers });
  }
  if (run.engine !== "CLI" && run.engine !== "SDK" || isTerminalRunTrigger(run.trigger)) {
    return NextResponse.json({ error: "This Run has no supported live session transport." }, { status: 409, headers });
  }
  const key = { runId: run.id, requestId: parsed.data.requestId };
  let message = await prisma.workSteeringMessage.findUnique({
    where: { runId_requestId: key },
  });
  let newlyCreated = false;
  if (message) {
    if (
      message.workId !== work.id ||
      message.sessionId !== run.copilotSessionId ||
      message.content !== parsed.data.prompt
    ) {
      return NextResponse.json(
        { error: "This request ID is already associated with a different instruction." },
        { status: 409, headers }
      );
    }
  } else {
    const controller = getManagedSessionController(run.id);
    const reason = getSteeringAvailabilityReason({
      workStatus: work.status,
      workHostname: work.hostname,
      currentHostname: hostname(),
      run: {
        status: run.status,
        trigger: run.trigger,
        engine: run.engine,
        hostname: run.hostname,
        sessionId: run.copilotSessionId,
      },
      expectedSessionId: parsed.data.sessionId,
      controller,
    });
    if (reason) {
      return NextResponse.json(
        { error: reason },
        { status: 409, headers }
      );
    }
    try {
      message = await prisma.workSteeringMessage.create({
        data: {
          id: randomUUID(),
          workId: work.id,
          runId: run.id,
          sessionId: run.copilotSessionId,
          requestId: parsed.data.requestId,
          content: parsed.data.prompt,
        },
      });
      newlyCreated = true;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      message = await prisma.workSteeringMessage.findUnique({ where: { runId_requestId: key } });
      if (!message) throw error;
      if (
        message.workId !== work.id ||
        message.sessionId !== run.copilotSessionId ||
        message.content !== parsed.data.prompt
      ) {
        return NextResponse.json(
          { error: "This request ID is already associated with a different instruction." },
          { status: 409, headers }
        );
      }
    }
  }

  try {
    const record = message as WorkSteeringMessageRecord;
    const controller = newlyCreated ? getManagedSessionController(run.id) : null;
    const result = await processWorkSteeringMessage({
      message: record,
      newlyCreated,
      controller,
      repository: {
        update: async (messageId, changes) =>
          prisma.workSteeringMessage.update({ where: { id: messageId }, data: changes }),
      },
      appendArtifact: async (accepted) => {
        if (!accepted.acceptedAt) throw new Error("Transport acceptance timestamp is missing");
        await appendWorkRunSteeringArtifact(
          getWorkRunArtifactPaths(work.directoryPath, run.id),
          {
            id: accepted.id,
            requestId: accepted.requestId,
            sessionId: accepted.sessionId,
            content: accepted.content,
            transportMessageId: accepted.transportMessageId,
            acceptedAt: accepted.acceptedAt.toISOString(),
          }
        );
      },
      appendPrompt: async (accepted) =>
        ensureSteeringPrompt(work, {
          id: accepted.id,
          createdAt: accepted.acceptedAt ?? accepted.createdAt,
          content: accepted.content,
        }),
    });
    return NextResponse.json(
      {
        messageId: message.id,
        requestId: message.requestId,
        deliveryState: result.deliveryState,
        transportAccepted: result.transportAccepted,
        promptSynced: result.promptSynced,
        artifactSynced: result.artifactSynced,
        notice: result.message,
      },
      { status: newlyCreated ? 202 : 200, headers }
    );
  } catch (error) {
    if (error instanceof SteeringRequestError) {
      return NextResponse.json(
        { error: error.message, deliveryState: error.deliveryState ?? null },
        { status: error.status, headers }
      );
    }
    console.error("[work-steering] Failed to record steering:", error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json(
      { error: "Steering could not be confirmed. Do not submit a new request ID until its status is resolved." },
      { status: 500, headers }
    );
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "P2002";
}
