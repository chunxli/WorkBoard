import { describe, expect, it } from "vitest";
import { activityRecords, conversationTimeline, withPendingFollowUp, type PendingFollowUp } from "./conversation-activity";
import { normalizeConversationEvent, type ConversationEvent } from "./session-conversation";

function event(type: string, offset: number, data: Record<string, unknown> = {}, agentId: string | null = null): ConversationEvent {
  return normalizeConversationEvent({ id: `event-${offset}`, type, data, agentId, timestamp: "2026-10-23T02:00:00Z" }, "fixture", offset)!;
}

describe("conversation activity timeline", () => {
  it("keeps registered attachment-only user messages in the prose timeline", () => {
    const message = event("user.message", 0, { content: "" });
    message.attachments = [{ id: "file-id", requestId: "request-id", uploadId: "upload-id", name: "image.png",
      storedName: "file-image.png", size: 12, mediaType: "image/png", sha256: "0".repeat(64) }];
    expect(conversationTimeline([message])).toEqual([{ kind: "message", event: message }]);
  });

  it("omits empty prose without mutating raw events or dropping meaningful runtime events", () => {
    const events = [
      event("assistant.message", 0, { content: "" }),
      event("assistant.message", 1, { content: " \n\t" }),
      event("session.usage_checkpoint", 2),
      event("assistant.message", 3, { content: "Actual answer" }),
    ];
    const before = JSON.stringify(events);
    const timeline = conversationTimeline(events);
    expect(timeline.filter((item) => item.kind === "message").map((item) => item.event.text)).toEqual(["Actual answer"]);
    expect(timeline.filter((item) => item.kind === "activity").flatMap((item) => item.events).map((item) => item.type))
      .toEqual(["session.usage_checkpoint"]);
    expect(JSON.stringify(events)).toBe(before);
  });

  it("respects an empty user-turn boundary without adding an empty bubble", () => {
    const items = conversationTimeline([
      event("tool.execution_start", 0, { toolCallId: "same", toolName: "rg" }),
      event("user.message", 1, { content: "" }),
      event("tool.execution_complete", 2, { toolCallId: "same", success: true }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.kind === "activity")).toBe(true);
  });
  it("collects a reply's tool events and trailing runtime metadata without collapsing prose", () => {
    const events = [
      event("user.message", 0, { content: "User request" }),
      event("tool.execution_start", 1, { toolCallId: "read-1", toolName: "read_file", arguments: { path: "one.txt" } }),
      event("tool.execution_complete", 2, { toolCallId: "read-1", success: true, result: "File content" }),
      event("assistant.message", 3, { content: "Main answer" }),
      event("assistant.turn_end", 4),
      event("session.usage_checkpoint", 5),
      event("session.shutdown", 6),
    ];
    const items = conversationTimeline(events);
    expect(items.map((item) => item.kind)).toEqual(["message", "activity", "message"]);
    const activity = items[1];
    expect(activity.kind).toBe("activity");
    if (activity.kind !== "activity") throw new Error("Expected an activity group");
    expect(activity.events.map((entry) => entry.type)).toEqual([
      "tool.execution_start", "tool.execution_complete", "assistant.turn_end", "session.usage_checkpoint", "session.shutdown",
    ]);
    expect(activity.finished).toBe(true);
    expect(activityRecords(activity.events)[0].events).toEqual(events.slice(1, 3));
    expect(items.filter((item) => item.kind === "message").map((item) => item.event.text))
      .toEqual(["User request", "Main answer"]);
  });

  it("preserves the order and exact contents of every root assistant/user message", () => {
    const events = [
      event("assistant.message", 0, { content: "First paragraph" }),
      event("tool.execution_start", 1, { toolName: "rg" }),
      event("assistant.message", 2, { content: "Second paragraph" }),
      event("session.usage_checkpoint", 3),
      event("assistant.message", 4, { content: "Final paragraph" }),
    ];
    expect(conversationTimeline(events).filter((item) => item.kind === "message").map((item) => item.event))
      .toEqual([events[0], events[2], events[4]]);
  });

  it("never combines tool IDs across user turns", () => {
    const items = conversationTimeline([
      event("tool.execution_start", 0, { toolCallId: "reused", toolName: "rg" }),
      event("user.message", 1, { content: "Next task" }),
      event("tool.execution_complete", 2, { toolCallId: "reused", success: true }),
    ]);
    const groups = items.filter((item) => item.kind === "activity");
    expect(groups).toHaveLength(2);
    expect(groups[0].finished).toBe(true);
    expect(groups.map((group) => activityRecords(group.events)[0].events.length)).toEqual([1, 1]);
  });

  it.each(["session.start", "session.resume", "assistant.turn_start"])(
    "starts a distinct activity at a recorded %s boundary",
    (boundary) => {
      const groups = conversationTimeline([
        event("tool.execution_complete", 0, { success: true }),
        event("assistant.turn_end", 1),
        event(boundary, 2),
        event("tool.execution_start", 3, { toolName: "view" }),
      ]).filter((item) => item.kind === "activity");
      expect(groups).toHaveLength(2);
      expect(groups[0].finished).toBe(true);
      expect(groups[1].events[0].type).toBe(boundary);
    },
  );

  it("a new turn after idle can show live progress instead of inheriting finished state", () => {
    const groups = conversationTimeline([
      event("session.idle", 0),
      event("assistant.turn_start", 1),
      event("tool.execution_start", 2, { toolName: "view" }),
    ]).filter((item) => item.kind === "activity");
    expect(groups).toHaveLength(2);
    expect(groups[1].finished).toBe(false);
  });

  it("subagent turn boundaries do not finish the parent's activity", () => {
    const groups = conversationTimeline([
      event("tool.execution_start", 0, { toolName: "task" }),
      event("assistant.turn_end", 1, {}, "subagent"),
      event("assistant.turn_start", 2),
    ]).filter((item) => item.kind === "activity");
    expect(groups).toHaveLength(1);
    expect(groups[0].turnEnded).toBe(false);
  });

  it("every retained event appears exactly once, and input events are not changed", () => {
    const events = [
      event("session.start", 0), event("user.message", 1, { content: "Request" }),
      event("tool.execution_start", 2), event("assistant.message", 3, { content: "Answer" }),
      event("assistant.turn_end", 4), event("session.shutdown", 5),
    ];
    const before = JSON.stringify(events);
    const retained = conversationTimeline(events).flatMap((item) => item.kind === "activity" ? item.events : [item.event]);
    expect(retained.map((entry) => entry.id).sort()).toEqual(events.map((entry) => entry.id).sort());
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("pending Follow Up chronology", () => {
  const pending: PendingFollowUp = {
    runId: "follow-up-run", text: "Update the report", timestamp: "2026-10-28T08:17:46.837Z",
  };
  const at = (type: string, offset: number, timestamp: string | null, data: Record<string, unknown> = {}) =>
    ({ ...event(type, offset, data), timestamp });
  const prose = (events: ConversationEvent[]) => conversationTimeline(events)
    .filter((item) => item.kind === "message").map((item) => item.event.text);

  it("keeps the input before its response when refresh loads a tail without the original user event", () => {
    const source = at("user.message", 100, "2026-10-28T08:17:55Z", { content: pending.text });
    const tail = [
      at("tool.execution_start", 200, "2026-10-28T08:18:00Z"),
      at("assistant.message", 300, "2026-10-28T08:18:17Z", { content: "Updating the report" }),
      at("assistant.turn_start", 400, "2026-10-28T08:20:41Z"),
    ];
    const live = withPendingFollowUp([source, ...tail], pending);
    const refreshed = withPendingFollowUp(tail, pending);
    expect(prose(refreshed)).toEqual(prose(live));
    expect(refreshed[0]).toMatchObject({
      id: "follow-up:follow-up-run", type: "work.follow_up", timestamp: pending.timestamp, text: pending.text,
    });
    expect(refreshed.slice(1)).toEqual(tail);
  });

  it("uses the saved submission time rather than appending after newer messages", () => {
    const before = at("assistant.message", 10, "2026-10-28T08:14:37Z", { content: "Previous answer" });
    const after = at("assistant.message", 30, "2026-10-28T08:18:17Z", { content: "New answer" });
    expect(prose(withPendingFollowUp([before, after], pending))).toEqual(["Previous answer", pending.text, "New answer"]);
  });

  it("removes the placeholder when Earlier loads the real input, without changing source events", () => {
    const source = at("user.message", 100, "2026-10-28T08:17:55Z", { content: pending.text });
    const answer = at("assistant.message", 200, "2026-10-28T08:18:17Z", { content: "Answer" });
    expect(withPendingFollowUp([answer], pending).filter((entry) => entry.role === "user")).toHaveLength(1);
    const loaded = [source, answer];
    expect(withPendingFollowUp(loaded, pending)).toBe(loaded);
    expect(prose(withPendingFollowUp(loaded, pending))).toEqual([pending.text, "Answer"]);
  });

  it("does not mistake an identical instruction from an older Run for the current input", () => {
    const older = at("user.message", 10, "2026-10-28T08:14:00Z", { content: pending.text });
    const answer = at("assistant.message", 30, "2026-10-28T08:18:17Z", { content: "New answer" });
    expect(prose(withPendingFollowUp([older, answer], pending))).toEqual([pending.text, pending.text, "New answer"]);
  });

  it("uses the last known source offset before Run metadata is received", () => {
    const unconfirmed = { ...pending, timestamp: null, afterOffset: 20 };
    const older = at("user.message", 10, null, { content: pending.text });
    const activity = at("assistant.turn_start", 30, null);
    const merged = withPendingFollowUp([older, activity], unconfirmed);
    expect(merged.map((entry) => entry.type)).toEqual(["user.message", "work.follow_up", "assistant.turn_start"]);
    const source = at("user.message", 40, null, { content: pending.text });
    const observed = [older, activity, source];
    expect(withPendingFollowUp(observed, unconfirmed)).toBe(observed);
  });

  it("keeps a queued input after earlier events and handles empty history", () => {
    const earlier = at("session.shutdown", 10, "2026-10-28T08:14:38Z");
    expect(withPendingFollowUp([earlier], pending).map((entry) => entry.type)).toEqual(["session.shutdown", "work.follow_up"]);
    expect(withPendingFollowUp([], pending)).toHaveLength(1);
  });

  it("does not sort or mutate source events with absent or out-of-order timestamps", () => {
    const events = [
      at("session.usage_info", 10, null),
      at("assistant.message", 20, "2026-10-28T08:18:17Z", { content: "Answer" }),
      at("tool.execution_complete", 30, "2026-10-28T08:18:00Z"),
    ];
    const saved = JSON.stringify(events);
    const merged = withPendingFollowUp(events, pending);
    expect(merged.filter((entry) => entry.type !== "work.follow_up")).toEqual(events);
    expect(merged[1].type).toBe("work.follow_up");
    expect(JSON.stringify(events)).toBe(saved);
  });

  it("requires the registered attachments before considering an attachment-only input observed", () => {
    const file = { id: "file-id", requestId: "request-id", uploadId: "upload-id", name: "image.png",
      storedName: "file-image.png", size: 12, mediaType: "image/png", sha256: "0".repeat(64) };
    const attachmentOnly = { ...pending, text: "", attachments: [file] };
    const source = at("user.message", 100, "2026-10-28T08:17:55Z", { content: "" });
    expect(withPendingFollowUp([source], attachmentOnly)).toHaveLength(2);
    const observed = [{ ...source, attachments: [file] }];
    expect(withPendingFollowUp(observed, attachmentOnly)).toBe(observed);
    expect(withPendingFollowUp([], attachmentOnly)[0].attachments).toEqual([file]);
  });

  it("does not treat a subagent user message as the submitted root input", () => {
    const source = { ...at("user.message", 100, "2026-10-28T08:17:55Z", { content: pending.text }), agentId: "child" };
    expect(withPendingFollowUp([source], pending)).toHaveLength(2);
  });

  it("leaves history untouched when no input is pending", () => {
    const events = [event("assistant.turn_start", 10)];
    expect(withPendingFollowUp(events, null)).toBe(events);
  });
});

describe("correlated tool records", () => {
  it("uses explicit toolCallId and agent identity to combine start and result", () => {
    const start = event("tool.execution_start", 0, { toolCallId: "call", toolName: "rg", arguments: { query: "value" } });
    const result = event("tool.execution_complete", 2, { toolCallId: "call", success: false, result: "Failed query" });
    const records = activityRecords([start, event("session.usage_checkpoint", 1), result]);
    expect(records).toHaveLength(2);
    expect(records[0].events).toEqual([start, result]);
    expect(records[0].events.at(-1)?.status).toBe("failed");
  });

  it("keeps the same tool ID in different subagents separate", () => {
    const records = activityRecords([
      event("tool.execution_start", 0, { toolCallId: "call", toolName: "view" }, "one"),
      event("tool.execution_complete", 1, { toolCallId: "call", success: true }, "two"),
    ]);
    expect(records).toHaveLength(2);
  });

  it("does not invent tool correlation when IDs or earlier history are missing", () => {
    const records = activityRecords([
      event("tool.execution_start", 0, { toolName: "rg" }),
      event("tool.execution_complete", 1, { success: true }),
      event("tool.execution_complete", 2, { toolCallId: "missing-start", success: true }),
    ]);
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.events.length === 1)).toBe(true);
  });
});
