import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { ConversationReadError } from "@/lib/session-conversation";
import { createConversationPinSchema } from "@/lib/conversation-pin-types";
import { ownedPinSession, pinContentHash, readPinTarget, serializeConversationPin } from "@/lib/conversation-pins";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const querySchema = z.object({ runId: z.string().min(1).max(128), pinId: z.string().min(1).max(128).optional() }).strict();
type Context = { params: Promise<{ id: string }> };

function failure(error: unknown) {
  if (error instanceof ConversationReadError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
  console.error("[conversation-pins] Request failed:", error);
  return NextResponse.json({ error: "Unable to update conversation Pins. Retry the same action." }, { status: 500, headers });
}

export async function GET(req: NextRequest, { params }: Context) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success || parsed.data.pinId) return NextResponse.json({ error: "Invalid Pin request" }, { status: 400, headers });
  try {
    const { id } = await params;
    const sessionId = await ownedPinSession(id, userId, parsed.data.runId);
    const pins = await prisma.workConversationPin.findMany({
      where: { workId: id, sessionId }, orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ sessionId, pins: pins.map(serializeConversationPin) }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest, { params }: Context) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const parsed = createConversationPinSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid Pin target" }, { status: 400, headers });
  try {
    const { id } = await params;
    const sessionId = await ownedPinSession(id, userId, parsed.data.runId);
    const { event, text } = await readPinTarget(sessionId, parsed.data);
    const pin = await prisma.workConversationPin.upsert({
      where: { workId_sessionId_eventId_line: { workId: id, sessionId, eventId: event.id, line: parsed.data.line } },
      create: { workId: id, sessionId, eventId: event.id, eventOffset: event.offset, line: parsed.data.line,
        contentHash: pinContentHash(event), preview: text.trim().slice(0, 240), timestamp: event.timestamp },
      update: { contentHash: pinContentHash(event), preview: text.trim().slice(0, 240), timestamp: event.timestamp },
    });
    return NextResponse.json({ pin: serializeConversationPin(pin) }, { status: 201, headers });
  } catch (error) { return failure(error); }
}

export async function DELETE(req: NextRequest, { params }: Context) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success || !parsed.data.pinId) return NextResponse.json({ error: "Invalid Pin request" }, { status: 400, headers });
  try {
    const { id } = await params;
    const sessionId = await ownedPinSession(id, userId, parsed.data.runId);
    await prisma.workConversationPin.deleteMany({ where: { id: parsed.data.pinId, workId: id, sessionId } });
    return NextResponse.json({ removed: true }, { headers });
  } catch (error) { return failure(error); }
}
