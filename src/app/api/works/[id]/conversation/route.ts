import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { getManagedSessionController } from "@/lib/managed-session-controller";
import { isNativeCopilotRunActive } from "@/lib/copilot-runner";
import { getSteeringAvailabilityReason, isWorkSteeringRequestInFlight } from "@/lib/work-steering";
import { authMode } from "@/lib/auth-mode";
import { getCopilotSessionEventsPath } from "@/lib/copilot-session-compat";
import { getTerminalSessionActivity } from "@/lib/terminal-resume";
import { findActiveRunConflicts } from "@/lib/run-access";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { ConversationReadError, readSessionConversationPage, type SessionConversationData } from "@/lib/session-conversation";
import { parseWorkAttachments } from "@/lib/work-attachments";
import { attachmentRelativePath } from "@/lib/work-attachment-types";
import { getWorkQueueBlockedReason, orderPendingWorkRuns, QUEUED_FOLLOW_UP_MODE } from "@/lib/work-run-queue";
import { readPinTarget } from "@/lib/conversation-pins";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };
const querySchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  cursor: z.string().max(2048).optional(),
  before: z.string().max(2048).optional(),
  download: z.literal("1").optional(),
  pin: z.string().min(1).max(128).optional(),
}).strict();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success || parsed.data?.cursor && parsed.data.before ||
    parsed.data?.pin && (parsed.data.cursor || parsed.data.before || parsed.data.download)) {
    return NextResponse.json({ error: "Invalid conversation request" }, { status: 400, headers });
  }
  const { id } = await params;
  const work = await prisma.work.findFirst({
    where: { id, userId },
    select: { id: true, hostname: true, status: true, directoryPath: true, promptHash: true },
  });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404, headers });
  const anchor = await prisma.run.findFirst({
    where: { workId: id, experimentVariantId: null, ...(parsed.data.runId ? { id: parsed.data.runId } : {}) },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, copilotSessionId: true, hostname: true, executionPath: true },
  });
  if (parsed.data.runId && !anchor) return NextResponse.json({ error: "Run not found" }, { status: 404, headers });
  const base: SessionConversationData = {
    sessionId: anchor?.copilotSessionId ?? null, anchorRunId: anchor?.id ?? null,
    continuationParentRunId: null, events: [], runs: [], nextCursor: null, previousCursor: null,
    hasMore: false, hasEarlier: false, incompleteTail: false, revision: null, historyAvailable: false,
    historyUnavailableReason: null, canFollowUp: false, blockedReason: null, terminalActive: false,
    canSteer: false, steeringRunId: null, steeringBlockedReason: null, steeringMessages: [],
    promptHash: work.promptHash, pendingPrompt: null,
    canQueue: false, queueParentRunId: null, queueBlockedReason: null, queuedMessageCount: 0, queuedMessages: [],
  };
  try {
    if (work.hostname && work.hostname !== hostname() || anchor?.hostname && anchor.hostname !== hostname()) {
      throw new ConversationReadError("This session is stored on another machine", 409);
    }
    const conflicts = await findActiveRunConflicts(userId, anchor?.executionPath ?? work.directoryPath);
    if (!anchor?.copilotSessionId) {
      if (parsed.data.pin) throw new ConversationReadError("This Run has no available Session for Pins.", 404);
      base.historyUnavailableReason = anchor ? "Session history has not been created yet." : "No session yet.";
      base.blockedReason = work.status === "ARCHIVED" ? "Restore this Work before following up."
        : conflicts.length ? "Wait for the active Run to finish." : anchor ? "Wait for the session to start." : null;
      base.canFollowUp = !base.blockedReason;
      base.queueBlockedReason = base.blockedReason ?? "Wait for this Run to prepare its session.";
      return NextResponse.json(base, { headers });
    }
    const sessionId = anchor.copilotSessionId;
    const unrelated = await prisma.run.findFirst({
      where: { copilotSessionId: sessionId, OR: [{ workId: null }, { workId: { not: id } }] },
      select: { id: true },
    });
    if (unrelated) throw new ConversationReadError("This session is associated with another Work and cannot be combined here", 409);
    const runs = await prisma.run.findMany({
      where: { workId: id, copilotSessionId: sessionId, experimentVariantId: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, trigger: true, hostname: true, createdAt: true, startedAt: true, finishedAt: true,
        engine: true, attachmentsJson: true, concurrencyMode: true, resumedFromRunId: true,
        terminalLaunches: { select: { id: true }, take: 1 } },
    });
    if (!work.hostname && !anchor.hostname && !runs.some((run) => run.hostname === hostname()) && authMode !== "local") {
      throw new ConversationReadError("The host of this older session could not be verified. Its Run artifacts remain available.", 409);
    }
    const current = runs[0];
    const managedRun = runs.find((run) => run.status === "RUNNING");
    const managedController = managedRun?.engine === "SDK" && managedRun.hostname === hostname()
      ? getManagedSessionController(managedRun.id)
      : null;
    const ownedNativeRun = managedRun?.engine === "CLI" && managedRun.hostname === hostname()
      && isNativeCopilotRunActive(managedRun.id);
    const currentActive = current && ["PENDING", "RUNNING"].includes(current.status);
    const activity = managedController || ownedNativeRun
      ? { active: false, starting: false }
      : await getTerminalSessionActivity(sessionId, current?.terminalLaunches[0]?.id ?? null,
          currentActive && isTerminalRunTrigger(current.trigger) ? current.createdAt : undefined);
    const stoppedRunId = currentActive && isTerminalRunTrigger(current.trigger) && !activity.active && !activity.starting ? current.id : null;
    const activeOwners = await prisma.run.findMany({
      where: { workId: id, status: { in: ["PENDING", "RUNNING"] }, ...(stoppedRunId ? { id: { not: stoppedRunId } } : {}) },
      select: { id: true, trigger: true, copilotSessionId: true, hostname: true, experimentVariantId: true,
        createdAt: true, resumedFromRunId: true },
    });
    base.runs = runs.map((run) => ({ id: run.id, status: run.status, trigger: run.trigger,
      createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null }));
    const parent = stoppedRunId ? current : runs.find((run) => !["PENDING", "RUNNING"].includes(run.status) && run.startedAt !== null);
    base.continuationParentRunId = parent?.id ?? null;
    base.terminalActive = activity.active || activity.starting;
    const candidateSteeringRun = managedRun ??
      (current && ["PENDING", "RUNNING"].includes(current.status) ? current : null);
    base.steeringRunId = candidateSteeringRun?.id ?? null;
    base.steeringBlockedReason = candidateSteeringRun
      ? getSteeringAvailabilityReason({
          workStatus: work.status,
          workHostname: work.hostname,
          currentHostname: hostname(),
          run: {
            status: candidateSteeringRun.status,
            trigger: candidateSteeringRun.trigger,
            engine: candidateSteeringRun.engine,
            hostname: candidateSteeringRun.hostname,
            sessionId,
          },
          expectedSessionId: sessionId,
          controller: candidateSteeringRun.id === managedRun?.id ? managedController : null,
        })
      : base.terminalActive
        ? "External Terminal sessions are read-only."
        : "Steering is available only while a managed Run is actively connected.";
    base.canSteer = base.steeringBlockedReason === null && managedRun !== undefined;
    base.blockedReason = work.status === "ARCHIVED" ? "Restore this Work before following up."
      : base.terminalActive ? "This session is open in Terminal. Close the Copilot session before sending."
        : activeOwners.length || conflicts.some((run) => run.id !== stoppedRunId) ? "Wait for the active Run to finish."
          : !parent ? "This session has not started yet." : null;
    const activeIds = new Set(activeOwners.map((run) => run.id));
    base.queueBlockedReason = work.status === "ARCHIVED" ? "Restore this Work before adding messages to its queue."
      : base.terminalActive ? "This session is open in Terminal. Close it before adding messages to the queue."
        : getWorkQueueBlockedReason(activeOwners, sessionId, hostname())
          ?? (conflicts.some((run) => run.id !== stoppedRunId && !activeIds.has(run.id))
            ? "Wait for the active Run in this Work directory to finish." : null);
    base.canQueue = base.queueBlockedReason === null;
    if (base.canQueue) base.queueParentRunId = orderPendingWorkRuns(activeOwners).at(-1)?.id ?? null;
    const queued = orderPendingWorkRuns(runs.filter((run) => run.status === "PENDING" && run.concurrencyMode === QUEUED_FOLLOW_UP_MODE));
    base.queuedMessageCount = queued.length;
    if (queued.length) {
      const previews = await prisma.run.findMany({
        where: { workId: id, id: { in: queued.slice(0, 20).map((run) => run.id) } },
        select: { id: true, promptSnapshot: true, attachmentsJson: true },
      });
      const byId = new Map(previews.map((run) => [run.id, run]));
      base.queuedMessages = queued.slice(0, 20).flatMap((run) => {
        const preview = byId.get(run.id);
        if (!preview) return [];
        const text = preview.promptSnapshot ?? "";
        return [{ runId: run.id, text: text.length > 500 ? `${text.slice(0, 500)}...` : text,
          createdAt: run.createdAt.toISOString(), attachments: parseWorkAttachments(preview.attachmentsJson) }];
      });
    }
    const promptRun = current?.concurrencyMode === QUEUED_FOLLOW_UP_MODE
      ? managedRun ?? runs.find((run) => run.startedAt !== null) : current;
    if (promptRun?.trigger === "FOLLOW_UP" && ["PENDING", "RUNNING", "FAILED"].includes(promptRun.status)
      && (promptRun.concurrencyMode !== QUEUED_FOLLOW_UP_MODE || promptRun.startedAt !== null)) {
      const pending = await prisma.run.findUnique({ where: { id: promptRun.id }, select: { promptSnapshot: true, attachmentsJson: true } });
      const attachments = parseWorkAttachments(pending?.attachmentsJson);
      const timestamp = promptRun.concurrencyMode === QUEUED_FOLLOW_UP_MODE ? promptRun.startedAt : promptRun.createdAt;
      if (timestamp && (pending?.promptSnapshot || attachments.length)) base.pendingPrompt = { runId: promptRun.id, text: pending?.promptSnapshot ?? "", status: promptRun.status, attachments,
        timestamp: timestamp.toISOString() };
    }
    if (parsed.data.download) {
      const filePath = getCopilotSessionEventsPath(sessionId);
      const info = await stat(filePath);
      const stream = createReadStream(filePath, { ...(info.size ? { end: info.size - 1 } : {}), signal: req.signal });
      return new Response(Readable.toWeb(stream) as ReadableStream, { headers: {
        ...headers, "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="session-${sessionId}.jsonl"`,
        "X-Content-Type-Options": "nosniff",
      } });
    }
    try {
      const pin = parsed.data.pin ? await prisma.workConversationPin.findFirst({
        where: { id: parsed.data.pin, workId: id, sessionId },
      }) : null;
      if (parsed.data.pin && !pin) throw new ConversationReadError("Pin not found in this Session.", 404);
      const page = pin ? (await readPinTarget(sessionId, pin)).page
        : await readSessionConversationPage(sessionId, { cursor: parsed.data.cursor, before: parsed.data.before });
      Object.assign(base, page, { historyAvailable: true });
      const steeringMessages = await prisma.workSteeringMessage.findMany({
        where: { workId: id, sessionId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, runId: true, requestId: true, content: true, deliveryState: true, promptSynced: true,
          promptError: true, artifactSynced: true, artifactError: true, createdAt: true,
          acceptedAt: true, transportMessageId: true, attachmentsJson: true,
        },
      });
      const knownFiles = [...runs, ...steeringMessages].flatMap((message) => parseWorkAttachments(message.attachmentsJson));
      const attachmentRoot = knownFiles.length ? await realpath(work.directoryPath) : work.directoryPath;
      const normalizePath = (value: string) => {
        const resolved = path.resolve(value);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      const knownPaths = new Map(knownFiles.map((file) => [
        normalizePath(path.join(attachmentRoot, ...attachmentRelativePath(work.id, file).split("/"))), file,
      ]));
      base.events = page.events.map(({ attachmentPaths, ...event }) => {
        const attachments = (attachmentPaths ?? []).flatMap((filePath) => {
          const file = knownPaths.get(normalizePath(filePath));
          return file ? [file] : [];
        });
        const steering = steeringMessages.find((message) => message.transportMessageId === event.messageId && event.messageId);
        for (const file of parseWorkAttachments(steering?.attachmentsJson)) {
          if (!attachments.some((existing) => existing.id === file.id)) attachments.push(file);
        }
        return { ...event, ...(attachments.length ? { attachments } : {}) };
      });
      const uncertainMessageIds = new Set<string>();
      for (const message of steeringMessages) {
        if (message.deliveryState === "SUBMITTING" &&
          !isWorkSteeringRequestInFlight(message.runId, message.requestId)) {
          uncertainMessageIds.add(message.id);
          await prisma.workSteeringMessage.updateMany({
            where: { id: message.id, deliveryState: "SUBMITTING" },
            data: {
              deliveryState: "UNCERTAIN",
              promptError: "Transport acceptance is unknown; this request was not replayed.",
            },
          });
        }
        if (message.deliveryState === "ACCEPTED" && message.transportMessageId &&
          page.events.some((event) => event.messageId === message.transportMessageId)) {
          await prisma.workSteeringMessage.updateMany({
            where: { id: message.id, deliveryState: "ACCEPTED" },
            data: { deliveryState: "OBSERVED", observedAt: new Date() },
          });
        }
      }
      base.steeringMessages = steeringMessages.map((message) => ({
        id: message.id,
        runId: message.runId,
        requestId: message.requestId,
        content: message.content,
        deliveryState: uncertainMessageIds.has(message.id)
          ? "UNCERTAIN"
          : message.transportMessageId &&
              page.events.some((event) => event.messageId === message.transportMessageId)
            ? "OBSERVED"
            : message.deliveryState,
        promptSynced: message.promptSynced,
        promptError: message.promptError ?? (uncertainMessageIds.has(message.id)
          ? "Transport acceptance is unknown; this request was not replayed."
          : null),
        artifactSynced: message.artifactSynced,
        artifactError: message.artifactError,
        createdAt: message.createdAt.toISOString(),
        acceptedAt: message.acceptedAt?.toISOString() ?? null,
        transportMessageId: message.transportMessageId,
      }));
    } catch (error) {
      if (error instanceof ConversationReadError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const active = anchor.status === "PENDING" || anchor.status === "RUNNING";
      base.historyUnavailableReason = active
        ? "Waiting for this Run to record session history. It will appear automatically when available."
        : "Stored session history is unavailable. The original Run logs and artifacts are still accessible.";
      base.blockedReason ??= active
        ? "Wait for the active Run to record its session history."
        : "Session history is unavailable. Start a new Work Run explicitly.";
    }
    base.canFollowUp = base.historyAvailable && base.blockedReason === null;
    return NextResponse.json(base, { headers });
  } catch (error) {
    if (error instanceof ConversationReadError) return NextResponse.json({ error: error.message, reset: error.reset }, { status: error.status, headers });
    console.error("[conversation] Failed to read session history:", error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json({ error: "Unable to read the session history. Run artifacts remain available." }, { status: 500, headers });
  }
}