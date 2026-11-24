import type { ConversationEvent } from "@/lib/session-conversation";

export interface ConversationActivity {
  kind: "activity";
  id: string;
  events: ConversationEvent[];
  startsUserTurn: boolean;
  turnEnded: boolean;
  finished: boolean;
}

type ConversationMessageItem = { kind: "message"; event: ConversationEvent };

export type ConversationTimelineItem = ConversationActivity | ConversationMessageItem;

export interface ActivityRecord {
  id: string;
  events: ConversationEvent[];
}

export interface ConversationActivitySummary {
  kind: "activity";
  id: string;
  records: ActivityRecord[];
  toolCount: number;
  eventCount: number;
  failures: number;
  status: "Running" | "Failed" | "Completed" | "Recorded";
  timestamp: string | null;
}

export interface PendingFollowUp {
  runId: string;
  text: string;
  timestamp: string | null;
  afterOffset?: number;
  attachments?: ConversationEvent["attachments"];
}

export function withPendingFollowUp(events: ConversationEvent[], pending: PendingFollowUp | null): ConversationEvent[] {
  if (!pending) return events;
  const submittedAt = pending.timestamp === null ? null : Date.parse(pending.timestamp);
  const afterSubmission = (event: ConversationEvent) => submittedAt === null
    ? pending.afterOffset !== undefined && event.offset > pending.afterOffset
    : event.timestamp !== null && Date.parse(event.timestamp) >= submittedAt;
  const observed = events.some((event) => event.role === "user" && event.agentId === null && afterSubmission(event) &&
    (pending.text ? event.text.includes(pending.text) : Boolean(pending.attachments?.length)) &&
    (pending.attachments ?? []).every((file) => event.attachments?.some((attachment) => attachment.id === file.id)));
  if (observed) return events;

  const message: ConversationEvent = {
    id: `follow-up:${pending.runId}`, sourceId: null, offset: -1, type: "work.follow_up",
    role: "user", messageId: null, title: "You", text: pending.text, timestamp: pending.timestamp,
    agentId: null, toolCallId: null, status: "info", attachments: pending.attachments,
  };
  const next = events.findIndex(afterSubmission);
  const index = next < 0 ? events.length : next;
  return [...events.slice(0, index), message, ...events.slice(index)];
}

export function isAuxiliaryEvent(event: ConversationEvent): boolean {
  return event.role === "tool" || event.role === "system" || event.agentId !== null;
}

export function isConversationMessage(event: ConversationEvent): boolean {
  return !isAuxiliaryEvent(event) && Boolean(event.text.trim() || event.attachments?.length);
}

export function conversationToolActivityAt(events: readonly ConversationEvent[]): string[] {
  return events.flatMap((event) => event.role === "tool" && event.timestamp !== null ? [event.timestamp] : []);
}

function startsRootSession(event: ConversationEvent): boolean {
  return event.agentId === null && (event.type === "session.start" || event.type === "session.resume");
}

export function conversationTimeline(events: ConversationEvent[]): ConversationTimelineItem[] {
  const timeline: ConversationTimelineItem[] = [];
  let activity: ConversationActivity | null = null;
  let startsUserTurn = false;
  for (const event of events) {
    if (!isAuxiliaryEvent(event)) {
      if (event.role === "user") {
        if (activity) activity.finished = true;
        activity = null;
        startsUserTurn = true;
      }
      if (isConversationMessage(event)) timeline.push({ kind: "message", event });
      continue;
    }
    const rootEvent = event.agentId === null;
    if (startsRootSession(event) || (rootEvent && event.type === "assistant.turn_start" && (activity?.turnEnded || activity?.finished))) {
      if (activity) activity.finished = true;
      activity = null;
    }
    if (!activity) {
      activity = { kind: "activity", id: event.id, events: [], startsUserTurn, turnEnded: false, finished: false };
      timeline.push(activity);
      startsUserTurn = false;
    }
    activity.events.push(event);
    if (rootEvent && event.type === "assistant.turn_end") activity.turnEnded = true;
    if (rootEvent && ["session.shutdown", "session.idle", "session.task_complete", "session.error", "abort"].includes(event.type)) {
      activity.finished = true;
    }
  }
  return timeline;
}

export function activityRecords(events: ConversationEvent[]): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  const calls = new Map<string, ActivityRecord>();
  for (const event of events) {
    const key = event.role === "tool" && event.toolCallId
      ? JSON.stringify([event.agentId, event.toolCallId]) : null;
    const previous = key ? calls.get(key) : undefined;
    if (previous) {
      previous.events.push(event);
    } else {
      const record = { id: event.id, events: [event] };
      records.push(record);
      if (key) calls.set(key, record);
    }
  }
  return records;
}

function summarizeActivity(activity: ConversationActivity, live: boolean): ConversationActivitySummary {
  const records = activityRecords(activity.events);
  const tools = records.filter((record) => record.events[0].role === "tool");
  const unfinished = records.some((record) => record.events[record.events.length - 1].status === "running");
  const failures = records.filter((record) => record.events.some((event) => event.status === "failed")).length;
  const active = live && !activity.finished && (unfinished || !activity.turnEnded);
  const completed = activity.finished || activity.turnEnded ||
    (tools.length > 0 && tools.every((record) => record.events[record.events.length - 1].status === "success"));
  return {
    kind: "activity", id: activity.id, records, toolCount: tools.length, eventCount: activity.events.length, failures,
    status: active ? "Running" : failures ? "Failed" : completed && !unfinished ? "Completed" : "Recorded",
    timestamp: activity.events[activity.events.length - 1].timestamp,
  };
}

export function conversationTimelineRows(timeline: readonly ConversationTimelineItem[], isLive: boolean) {
  const latestActivity = isLive ? timeline.findLast((item) => item.kind === "activity") : undefined;
  const rows: (ConversationMessageItem | ConversationActivitySummary)[] = [];
  let settled: ConversationActivitySummary[] = [];
  const flush = () => {
    if (settled.length > 1 && settled.some((item) => item.toolCount > 0)) {
      const failures = settled.reduce((count, item) => count + item.failures, 0);
      const hasUnconfirmedTool = settled.some((item) => item.status === "Recorded" && item.toolCount > 0);
      const hasCompleted = settled.some((item) => item.status === "Completed");
      rows.push({
        ...settled[0],
        // Correlation is scoped to the original activity; IDs can be reused in later turns.
        records: settled.flatMap((item) => item.records),
        toolCount: settled.reduce((count, item) => count + item.toolCount, 0),
        eventCount: settled.reduce((count, item) => count + item.eventCount, 0),
        failures,
        status: failures > 0 ? "Failed" : !hasUnconfirmedTool && hasCompleted ? "Completed" : "Recorded",
        timestamp: settled.findLast((item) => item.timestamp !== null)?.timestamp ?? settled[settled.length - 1].timestamp,
      });
    } else {
      settled.forEach((item) => rows.push(item));
    }
    settled = [];
  };
  for (const item of timeline) {
    if (item.kind === "message") {
      flush();
      rows.push(item);
      continue;
    }
    if (item.startsUserTurn || startsRootSession(item.events[0])) flush();
    const summary = summarizeActivity(item, item === latestActivity);
    if (summary.status !== "Running") settled.push(summary);
    else {
      flush();
      rows.push(summary);
    }
  }
  flush();
  return rows;
}
