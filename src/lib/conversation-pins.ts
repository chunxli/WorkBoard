import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "@/lib/prisma";
import { ConversationReadError, readSessionConversationPage, type ConversationEvent } from "@/lib/session-conversation";
import type { ConversationPin } from "@/lib/conversation-pin-types";

export async function ownedPinSession(workId: string, userId: string, runId: string): Promise<string> {
  const work = await prisma.work.findFirst({ where: { id: workId, userId }, select: { id: true, hostname: true } });
  if (!work) throw new ConversationReadError("Work not found", 404);
  const run = await prisma.run.findFirst({
    where: { id: runId, workId, experimentVariantId: null },
    select: { copilotSessionId: true, hostname: true },
  });
  if (!run?.copilotSessionId) throw new ConversationReadError("This Run has no available session.", 404);
  if (work.hostname && work.hostname !== hostname() || run.hostname && run.hostname !== hostname()) {
    throw new ConversationReadError("This session is stored on another machine.", 409);
  }
  const unrelated = await prisma.run.findFirst({
    where: { copilotSessionId: run.copilotSessionId, OR: [{ workId: null }, { workId: { not: workId } }] },
    select: { id: true },
  });
  if (unrelated) throw new ConversationReadError("This session is associated with another Work.", 409);
  return run.copilotSessionId;
}

export function pinContentHash(event: ConversationEvent): string {
  return createHash("sha256").update(`${event.type}\n${event.text}`).digest("hex");
}

export function pinLineText(event: ConversationEvent, line: number): string {
  const text = event.text.split(/\r\n|\n|\r/)[line - 1];
  if (event.role !== "assistant" || text === undefined || !text.trim()) {
    throw new ConversationReadError("Choose a non-empty line of recorded assistant output.", 400);
  }
  return text;
}

export async function readPinTarget(sessionId: string, target: {
  eventId: string; line: number; contentHash?: string; eventOffset?: number;
}, options: { baseDirectory?: string; pageBytes?: number } = {}) {
  const suffixOffset = Number(target.eventId.slice(target.eventId.lastIndexOf(":") + 1));
  const offset = target.eventOffset ?? suffixOffset;
  if (!/^[a-f0-9]{64}:\d+$/.test(target.eventId) || !Number.isSafeInteger(offset) || offset < 0 || offset !== suffixOffset) {
    throw new ConversationReadError("Invalid pinned conversation position.", 400);
  }
  try {
    const page = await readSessionConversationPage(sessionId, { ...options, atOffset: offset });
    const event = page.events.find((entry) => entry.id === target.eventId);
    if (!event || target.contentHash && pinContentHash(event) !== target.contentHash) {
      throw new ConversationReadError("The pinned source was changed or replaced. Remove this Pin and pin the new output.", 409);
    }
    const text = pinLineText(event, target.line);
    return { page, event, text };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ConversationReadError("Stored history for this Pin is unavailable.", 404);
    }
    throw error;
  }
}

export function serializeConversationPin(pin: {
  id: string; sessionId: string; eventId: string; line: number; preview: string; timestamp: string | null; createdAt: Date;
}): ConversationPin {
  return { id: pin.id, sessionId: pin.sessionId, eventId: pin.eventId, line: pin.line, preview: pin.preview,
    timestamp: pin.timestamp, createdAt: pin.createdAt.toISOString() };
}
