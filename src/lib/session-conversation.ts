import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { getCopilotSessionEventsPath, upgradeLegacyPermissionEvent } from "@/lib/copilot-session-compat";
import { SessionUsageCounter, type SessionUsage } from "@/lib/session-usage";
import { toolExecutionFailed } from "@/lib/tool-execution-outcome";
import type { WorkAttachment } from "@/lib/work-attachment-types";

export interface ConversationEvent {
  id: string;
  sourceId: string | null;
  offset: number;
  type: string;
  role: "user" | "assistant" | "tool" | "system";
  messageId: string | null;
  title: string;
  text: string;
  timestamp: string | null;
  agentId: string | null;
  toolCallId: string | null;
  status: "info" | "running" | "success" | "failed";
  attachmentPaths?: string[];
  attachments?: WorkAttachment[];
}

export interface ConversationRun {
  id: string;
  status: string;
  trigger: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SessionConversationData {
  sessionId: string | null;
  anchorRunId: string | null;
  displayRunId?: string;
  continuationParentRunId: string | null;
  events: ConversationEvent[];
  runs: ConversationRun[];
  nextCursor: string | null;
  previousCursor: string | null;
  hasMore: boolean;
  hasEarlier: boolean;
  incompleteTail: boolean;
  revision: string | null;
  historyAvailable: boolean;
  historyUnavailableReason: string | null;
  sessionUsage: SessionUsage | null;
  canFollowUp: boolean;
  canQueue: boolean;
  queueParentRunId: string | null;
  queueBlockedReason: string | null;
  queuedMessageCount: number;
  queuedMessages: { runId: string; text: string; createdAt: string; attachments: WorkAttachment[] }[];
  blockedReason: string | null;
  terminalActive: boolean;
  canSteer: boolean;
  steeringRunId: string | null;
  steeringBlockedReason: string | null;
  steeringMessages: {
    id: string;
    runId: string;
    requestId: string;
    content: string;
    deliveryState: "SUBMITTING" | "ACCEPTED" | "OBSERVED" | "UNCERTAIN" | "REJECTED";
    promptSynced: boolean;
    promptError: string | null;
    artifactSynced: boolean;
    artifactError: string | null;
    createdAt: string;
    acceptedAt: string | null;
    transportMessageId: string | null;
  }[];
  promptHash: string | null;
  pendingPrompt: { runId: string; text: string; status: string; timestamp?: string; attachments?: WorkAttachment[] } | null;
}

interface HistoryCursor {
  version: 1;
  session: string;
  generation: string;
  offset: number;
  prefixLength: number;
  prefixHash: string;
  previousHash: string;
  size: number;
  modifiedAt: number;
}

export class ConversationReadError extends Error {
  constructor(message: string, readonly status = 400, readonly reset = false) {
    super(message);
    this.name = "ConversationReadError";
  }
}

const PAGE_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const data = record(value);
  for (const key of ["detailedContent", "text", "content", "contents", "message"]) {
    if (data[key] !== undefined) return contentText(data[key]);
  }
  return "";
}

export function normalizeConversationEvent(value: unknown, generation: string, offset: number): ConversationEvent | null {
  const event = record(upgradeLegacyPermissionEvent(value).event);
  const data = record(event.data);
  const type = typeof event.type === "string" ? event.type : "unknown.event";
  if (type.endsWith("_delta") || type.endsWith(".delta")) return null;
  const agentId = typeof event.agentId === "string" ? event.agentId : null;
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
  const base: ConversationEvent = {
    id: `${generation}:${offset}`, sourceId: typeof event.id === "string" ? event.id : null,
    offset, type, role: "system", messageId: typeof data.messageId === "string" ? data.messageId : null, title: type, text: "",
    timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
    agentId, toolCallId, status: "info",
  };
  if (type === "user.message" || type === "assistant.message") {
    const paths = type === "user.message" && Array.isArray(data.attachments)
      ? data.attachments.flatMap((value) => {
        const attachment = record(value);
        return attachment.type === "file" && typeof attachment.path === "string" ? [attachment.path] : [];
      }).slice(0, 10) : [];
    return { ...base, role: type === "user.message" ? "user" : "assistant", title: type === "user.message" ? "You" : agentId ? "Subagent" : "Copilot",
      text: contentText(data.content), ...(paths.length ? { attachmentPaths: paths } : {}) };
  }
  if (type === "tool.execution_start") {
    return { ...base, role: "tool", title: typeof data.toolName === "string" ? data.toolName : "Tool call", status: "running",
      text: data.arguments === undefined ? "" : JSON.stringify(data.arguments, (key, item) => /^(env|environment|password|secret|token|apiKey|authorization)$/i.test(key) ? "[redacted]" : item, 2) };
  }
  if (type === "tool.execution_complete") {
    const failed = toolExecutionFailed(data);
    return { ...base, role: "tool", title: typeof data.toolName === "string" ? data.toolName : "Tool result", status: failed ? "failed" : "success",
      text: contentText(data.result) || contentText(data.error) || (data.result === undefined ? "" : JSON.stringify(data.result, null, 2)) };
  }
  if (type.startsWith("subagent.")) {
    return { ...base, title: typeof data.agentDisplayName === "string" ? data.agentDisplayName : typeof data.agentName === "string" ? data.agentName : "Subagent",
      status: type.endsWith("failed") ? "failed" : type.endsWith("started") ? "running" : "success", text: contentText(data.error) };
  }
  if (type === "session.error" || type === "abort") return { ...base, title: type === "abort" ? "Session interrupted" : "Session error", status: "failed", text: contentText(data.message) || contentText(data.error) };
  const titles: Record<string, string> = { "session.start": "Session started", "session.shutdown": "Session stopped", "session.idle": "Waiting for input", "session.task_complete": "Task completed" };
  return { ...base, title: titles[type] ?? type };
}

async function readBytes(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length));
  let used = 0;
  while (used < length) {
    const result = await file.read(buffer, used, length - used, position + used);
    if (!result.bytesRead) break;
    used += result.bytesRead;
  }
  return buffer.subarray(0, used);
}

type RecordedEvent = { kind: "event"; value: unknown } | { kind: "invalid-utf8" | "invalid-json" | "oversized" };

async function scanRecordedEvents(file: FileHandle, start: number, end: number,
  visit: (entry: RecordedEvent, offset: number) => void, budget = Infinity) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let position = start;
  let boundary = start;
  let chunks: Buffer[] = [];
  let recordBytes = 0;
  let incompleteTail = false;
  let appendable = true;

  const consume = (terminated: boolean) => {
    let entry: RecordedEvent | null = null;
    if (recordBytes > MAX_RECORD_BYTES) {
      entry = { kind: "oversized" };
    } else {
      let text: string | null = null;
      try { text = decoder.decode(Buffer.concat(chunks, recordBytes)).trim(); }
      catch { entry = { kind: "invalid-utf8" }; }
      if (text) {
        try { entry = { kind: "event", value: JSON.parse(text) }; }
        catch { entry = { kind: "invalid-json" }; }
      }
    }
    if (entry && entry.kind !== "event" && !terminated) { incompleteTail = true; return; }
    if (entry) visit(entry, boundary);
    boundary = position;
    chunks = [];
    recordBytes = 0;
    appendable = terminated;
  };

  while (position < end && boundary - start < budget) {
    const bytes = await readBytes(file, position, Math.min(64 * 1024, end - position));
    if (!bytes.length) throw new ConversationReadError("Session history changed while reading. Reload the conversation.", 409, true);
    let offset = 0;
    while (offset < bytes.length && boundary - start < budget) {
      const newline = bytes.indexOf(10, offset);
      const stop = newline < 0 ? bytes.length : newline + 1;
      const part = bytes.subarray(offset, stop);
      recordBytes += part.length;
      if (recordBytes > MAX_RECORD_BYTES) chunks = [];
      else chunks.push(part);
      position += part.length;
      offset = stop;
      if (newline >= 0) consume(true);
    }
  }
  if (position === end && recordBytes) consume(false);
  return { boundary, incompleteTail, appendable };
}

interface CachedSessionUsage {
  generation: string;
  size: number;
  modifiedAt: number;
  changedAt: number;
  prefixHash: string;
  boundary: number;
  boundaryHash: string;
  appendable: boolean;
  counter: SessionUsageCounter;
  snapshot: SessionUsage;
}

const sessionUsageCache = new Map<string, CachedSessionUsage>();
const sessionUsageReads = new Map<string, Promise<SessionUsage>>();
const MAX_CACHED_SESSION_USAGES = 16;
const boundaryHash = async (file: FileHandle, end: number) =>
  digest(await readBytes(file, Math.max(0, end - 128), Math.min(end, 128)));

async function readSessionUsage(file: FileHandle, eventsPath: string, generation: string, info: Stats, prefixHash: string) {
  const read = async () => {
    const cached = sessionUsageCache.get(eventsPath);
    const sameFile = cached?.generation === generation;
    if (sameFile && cached.size === info.size && cached.modifiedAt === info.mtimeMs && cached.changedAt === info.ctimeMs &&
        cached.prefixHash === prefixHash) {
      sessionUsageCache.delete(eventsPath);
      sessionUsageCache.set(eventsPath, cached);
      return cached.snapshot;
    }
    const append = sameFile && cached.appendable && cached.size < info.size &&
      cached.prefixHash === digest(await readBytes(file, 0, Math.min(cached.size, 128))) &&
      cached.boundaryHash === await boundaryHash(file, cached.boundary);
    sessionUsageCache.delete(eventsPath);
    const counter = append ? cached.counter : new SessionUsageCounter();
    const scan = await scanRecordedEvents(file, append ? cached.boundary : 0, info.size, (entry) => {
      if (entry.kind === "event") counter.add(entry.value);
      else counter.skipRecord();
    });
    const hash = await boundaryHash(file, scan.boundary);
    const after = await file.stat();
    if (after.size < info.size || after.ino !== info.ino ||
        after.size === info.size && (after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)) {
      throw new ConversationReadError("Session history changed while reading. Reload the conversation.", 409, true);
    }
    const snapshot = counter.snapshot();
    sessionUsageCache.set(eventsPath, {
      generation, size: info.size, modifiedAt: info.mtimeMs, changedAt: info.ctimeMs, prefixHash,
      boundary: scan.boundary, boundaryHash: hash, appendable: scan.appendable, counter, snapshot,
    });
    if (sessionUsageCache.size > MAX_CACHED_SESSION_USAGES) {
      const oldest = sessionUsageCache.keys().next();
      if (!oldest.done) sessionUsageCache.delete(oldest.value);
    }
    return snapshot;
  };
  // Serialize scans of the same file so concurrent polls never increment one cache twice.
  const previous = sessionUsageReads.get(eventsPath);
  const pending = previous ? previous.then(read, read) : read();
  sessionUsageReads.set(eventsPath, pending);
  try { return await pending; }
  finally {
    if (sessionUsageReads.get(eventsPath) === pending) sessionUsageReads.delete(eventsPath);
  }
}

async function lineStart(file: FileHandle, position: number): Promise<number> {
  while (position > 0) {
    const from = Math.max(0, position - 32 * 1024);
    const bytes = await readBytes(file, from, position - from);
    const newline = bytes.lastIndexOf(10);
    if (newline >= 0) return from + newline + 1;
    position = from;
  }
  return 0;
}

function parseCursor(value: string | undefined, sessionId: string): HistoryCursor | null {
  if (!value) return null;
  try {
    if (value.length > 2048) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as HistoryCursor;
    if (parsed.version !== 1 || parsed.session !== sessionId || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 ||
      !Number.isSafeInteger(parsed.prefixLength) || parsed.prefixLength < 0 || parsed.prefixLength > 128 ||
      !Number.isSafeInteger(parsed.size) || parsed.size < parsed.offset || !Number.isFinite(parsed.modifiedAt) ||
      ![parsed.generation, parsed.prefixHash, parsed.previousHash].every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) throw new Error();
    return parsed;
  } catch {
    throw new ConversationReadError("Invalid conversation cursor");
  }
}

export async function readSessionConversationPage(sessionId: string, options: {
  cursor?: string;
  before?: string;
  atOffset?: number;
  baseDirectory?: string;
  pageBytes?: number;
  includeUsage?: boolean;
} = {}) {
  if (options.cursor && options.before) throw new ConversationReadError("Choose either a forward or earlier cursor");
  if (options.atOffset !== undefined && (options.cursor || options.before || !Number.isSafeInteger(options.atOffset) || options.atOffset < 0)) {
    throw new ConversationReadError("Invalid pinned conversation position");
  }
  const cursor = parseCursor(options.cursor ?? options.before, sessionId);
  const eventsPath = getCopilotSessionEventsPath(sessionId, options.baseDirectory);
  const file = await open(eventsPath, "r");
  try {
    const info = await file.stat();
    const generation = digest(`${sessionId}:${info.dev}:${info.ino}:${info.birthtimeMs}`);
    if (options.atOffset !== undefined && (options.atOffset >= info.size ||
      options.atOffset > 0 && (await readBytes(file, options.atOffset - 1, 1))[0] !== 10)) {
      throw new ConversationReadError("The pinned conversation position is no longer available.", 409);
    }
    if (cursor) {
      const prefix = await readBytes(file, 0, cursor.prefixLength);
      const previous = await readBytes(file, Math.max(0, cursor.offset - 128), Math.min(cursor.offset, 128));
      if (cursor.generation !== generation || cursor.offset > info.size || prefix.length !== cursor.prefixLength ||
        info.size === cursor.size && info.mtimeMs !== cursor.modifiedAt ||
        digest(prefix) !== cursor.prefixHash || digest(previous) !== cursor.previousHash) {
        throw new ConversationReadError("Session history changed. Reload the conversation.", 409, true);
      }
    }
    const budget = Math.max(64, Math.min(options.pageBytes ?? PAGE_BYTES, PAGE_BYTES));
    const end = options.before && cursor ? cursor.offset : info.size;
    const start = options.atOffset ?? (options.cursor && cursor ? cursor.offset : await lineStart(file, Math.max(0, end - budget)));
    const events: ConversationEvent[] = [];
    const { boundary, incompleteTail } = await scanRecordedEvents(file, start, end, (entry, recordStart) => {
      if (entry.kind === "oversized") {
        events.push({ id: `${generation}:${recordStart}`, sourceId: null, offset: recordStart, type: "oversized.event", role: "system",
          messageId: null, title: "Large recorded event", text: "This event is too large for the conversation view. Download the full session history to inspect it.",
          timestamp: null, agentId: null, toolCallId: null, status: "info" });
      } else if (entry.kind === "invalid-utf8") {
        throw new ConversationReadError("Session history contains an invalid UTF-8 record", 422);
      } else if (entry.kind === "invalid-json") {
        throw new ConversationReadError("Session history contains a damaged record. Raw history remains available.", 422);
      } else if (entry.kind === "event") {
        const event = normalizeConversationEvent(entry.value, generation, recordStart);
        if (event) events.push(event);
      }
    }, options.before ? Infinity : budget);
    const after = await file.stat();
    if (after.size < info.size || after.ino !== info.ino) throw new ConversationReadError("Session history changed while reading", 409, true);
    const prefixLength = Math.min(info.size, 128);
    const prefixHash = digest(await readBytes(file, 0, prefixLength));
    const token = async (offset: number) => Buffer.from(JSON.stringify({
      version: 1, session: sessionId, generation, offset, prefixLength, prefixHash,
      size: info.size, modifiedAt: info.mtimeMs,
      previousHash: digest(await readBytes(file, Math.max(0, offset - 128), Math.min(offset, 128))),
    } satisfies HistoryCursor)).toString("base64url");
    return {
      events, nextCursor: await token(boundary), previousCursor: start > 0 ? await token(start) : null,
      hasMore: !incompleteTail && boundary < end && !options.before,
      hasEarlier: start > 0, incompleteTail, revision: `${generation}:${info.size}:${info.mtimeMs}`,
      generation, sourceBytes: info.size,
      ...(options.includeUsage ? { sessionUsage: await readSessionUsage(file, eventsPath, generation, info, prefixHash) } : {}),
    };
  } finally {
    await file.close();
  }
}