import type { ConversationEvent } from "@/lib/session-conversation";

export interface ConversationActivity {
  kind: "activity";
  id: string;
  events: ConversationEvent[];
  turnEnded: boolean;
  finished: boolean;
}

export type ConversationTimelineItem =
  | ConversationActivity
  | { kind: "message"; event: ConversationEvent };

export interface ActivityRecord {
  id: string;
  events: ConversationEvent[];
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

export function conversationTimeline(events: ConversationEvent[]): ConversationTimelineItem[] {
  const timeline: ConversationTimelineItem[] = [];
  let activity: ConversationActivity | null = null;
  for (const event of events) {
    if (!isAuxiliaryEvent(event)) {
      if (event.role === "user") {
        if (activity) activity.finished = true;
        activity = null;
      }
      if (event.text.trim() || event.attachments?.length) timeline.push({ kind: "message", event });
      continue;
    }
    const rootEvent = event.agentId === null;
    const startsSession = rootEvent && (event.type === "session.start" || event.type === "session.resume");
    if (startsSession || (rootEvent && event.type === "assistant.turn_start" && (activity?.turnEnded || activity?.finished))) {
      if (activity) activity.finished = true;
      activity = null;
    }
    if (!activity) {
      activity = { kind: "activity", id: event.id, events: [], turnEnded: false, finished: false };
      timeline.push(activity);
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
