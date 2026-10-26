import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { readWorkAttachment, saveWorkAttachment, WorkAttachmentError } from "@/lib/work-attachments";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const uploadSchema = z.object({
  requestId: z.string().uuid(), uploadId: z.string().uuid(), name: z.string().min(1).max(240),
  size: z.coerce.number().int().nonnegative(),
}).strict();
const viewSchema = z.object({
  requestId: z.string().uuid(), attachmentId: z.string().uuid(), download: z.literal("1").optional(),
}).strict();

function failure(error: unknown) {
  if (error instanceof WorkAttachmentError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
  const code = error instanceof Error && "code" in error ? error.code : null;
  if (code === "ENOENT" || code === "ENOTDIR") return NextResponse.json({ error: "This Work attachment is no longer available." }, { status: 404, headers });
  if (code === "EACCES" || code === "EPERM") return NextResponse.json({ error: "Permission denied for the Work attachment directory." }, { status: 403, headers });
  if (code === "ENOSPC") return NextResponse.json({ error: "There is not enough disk space for this attachment." }, { status: 507, headers });
  console.error("[work-attachments] Attachment operation failed:", error instanceof Error ? error.name : "Unknown error");
  return NextResponse.json({ error: "Unable to save or read the attachment. Check the server logs." }, { status: 500, headers });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id } = await params;
  const work = await prisma.work.findFirst({
    where: { id, userId }, select: { id: true, directoryPath: true, status: true, hostname: true },
  });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404, headers });
  if (work.status === "ARCHIVED" || work.hostname && work.hostname !== hostname()) {
    return NextResponse.json({ error: "This Work cannot receive attachments on this host." }, { status: 409, headers });
  }
  const origin = request.headers.get("origin");
  const requestOrigin = `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  if (request.headers.get("content-type")?.split(";")[0] !== "application/octet-stream" ||
    origin && origin !== requestOrigin) {
    return NextResponse.json({ error: "Attachments require a same-origin binary upload." }, { status: 403, headers });
  }
  const query = uploadSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid attachment upload metadata." }, { status: 400, headers });
  try {
    const attachment = await saveWorkAttachment({
      work, ...query.data, body: request.body, signal: request.signal,
    });
    return NextResponse.json({ attachment }, { status: 201, headers });
  } catch (error) { return failure(error); }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id } = await params;
  const work = await prisma.work.findFirst({
    where: { id, userId }, select: { id: true, directoryPath: true, hostname: true },
  });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404, headers });
  if (work.hostname && work.hostname !== hostname()) return NextResponse.json({ error: "Attachments belong to another host." }, { status: 409, headers });
  const query = viewSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid attachment reference." }, { status: 400, headers });
  try {
    const { attachment, bytes } = await readWorkAttachment(work, query.data.requestId, query.data.attachmentId);
    const inline = attachment.mediaType.startsWith("image/") && !query.data.download;
    const filename = encodeURIComponent(attachment.name).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(bytes), { headers: {
      ...headers,
      "Content-Type": inline ? attachment.mediaType : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    } });
  } catch (error) { return failure(error); }
}
