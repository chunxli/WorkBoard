import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConversationEvent, readSessionConversationPage } from "./session-conversation";

const directories: string[] = [];
const sessionId = "12345678-1234-4234-8234-123456789abc";
async function fixture(content: string | Buffer) {
  const baseDirectory = await mkdtemp(path.join(tmpdir(), "workboard-conversation-"));
  directories.push(baseDirectory);
  const directory = path.join(baseDirectory, "session-state", sessionId);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "events.jsonl");
  await writeFile(file, content);
  return { baseDirectory, file };
}
const message = (content: string) => JSON.stringify({ type: "user.message", data: { content } }) + "\n";
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("session conversation history", () => {
  it("retains native attachment references without trusting them as registered Work files", () => {
    const event = normalizeConversationEvent({ type: "user.message", data: { content: "", attachments: [
      { type: "file", path: "C:\\synthetic\\image.png", displayName: "image.png" },
      { type: "directory", path: "C:\\outside", displayName: "Not a Work attachment" },
    ] } }, "fixture", 0);
    expect(event).toMatchObject({ role: "user", text: "", attachmentPaths: ["C:\\synthetic\\image.png"] });
    expect(event).not.toHaveProperty("attachments");
  });

  it("keeps every retained event reachable beyond the old log limit", async () => {
    const state = await fixture(Array.from({ length: 2105 }, (_, index) => message(`turn ${index}`)).join(""));
    let page = await readSessionConversationPage(sessionId, { ...state, pageBytes: 1024 });
    const seen = new Map(page.events.map((event) => [event.id, event.text]));
    let before = page.previousCursor;
    while (before) {
      const earlier = await readSessionConversationPage(sessionId, { ...state, before, pageBytes: 1024 });
      earlier.events.forEach((event) => seen.set(event.id, event.text));
      before = earlier.previousCursor;
    }
    while (page.hasMore) {
      page = await readSessionConversationPage(sessionId, { ...state, cursor: page.nextCursor, pageBytes: 1024 });
      page.events.forEach((event) => seen.set(event.id, event.text));
    }
    expect(seen.size).toBe(2105);
    expect([...seen.values()]).toContain("turn 0");
    expect([...seen.values()]).toContain("turn 2104");
  });

  it("does not consume a partial UTF-8/JSON tail before the writer finishes it", async () => {
    const utf8 = Buffer.from(message("\u4f60\u597d"));
    const state = await fixture(Buffer.concat([Buffer.from(message("first")), utf8.subarray(0, utf8.length - 6)]));
    const first = await readSessionConversationPage(sessionId, state);
    expect(first.events.map((event) => event.text)).toEqual(["first"]);
    expect(first.incompleteTail).toBe(true);
    await appendFile(state.file, utf8.subarray(utf8.length - 6));
    const next = await readSessionConversationPage(sessionId, { ...state, cursor: first.nextCursor });
    expect(next.events.map((event) => event.text)).toEqual(["\u4f60\u597d"]);
    expect(next.incompleteTail).toBe(false);
  });

  it("polls new events without repeating the previous page", async () => {
    const state = await fixture(message("same"));
    const first = await readSessionConversationPage(sessionId, state);
    await appendFile(state.file, message("same"));
    const next = await readSessionConversationPage(sessionId, { ...state, cursor: first.nextCursor });
    expect(next.events).toHaveLength(1);
    expect(next.events[0].id).not.toBe(first.events[0].id);
    expect((await readSessionConversationPage(sessionId, { ...state, cursor: next.nextCursor })).events).toEqual([]);
  });

  it("requires reset on truncation or replacement and rejects another session cursor", async () => {
    const state = await fixture(message("original"));
    const first = await readSessionConversationPage(sessionId, state);
    await writeFile(state.file, "");
    await expect(readSessionConversationPage(sessionId, { ...state, cursor: first.nextCursor })).rejects.toMatchObject({ reset: true });
    await writeFile(state.file, message("original"));
    const current = await readSessionConversationPage(sessionId, state);
    await rename(state.file, state.file + ".old");
    await writeFile(state.file, message("original"));
    await expect(readSessionConversationPage(sessionId, { ...state, cursor: current.nextCursor })).rejects.toMatchObject({ reset: true });
    await expect(readSessionConversationPage("22345678-1234-4234-8234-123456789abc", { ...state, cursor: current.nextCursor })).rejects.toThrow("Invalid conversation cursor");
  });

  it("accepts a complete non-newline record and reports corrupt interior records", async () => {
    const state = await fixture(message("complete").trimEnd());
    expect((await readSessionConversationPage(sessionId, state)).events[0].text).toBe("complete");
    await writeFile(state.file, "{broken}\n");
    await expect(readSessionConversationPage(sessionId, state)).rejects.toMatchObject({ status: 422 });
  });

  it("detects a same-size rewrite even when the session retains its first and last bytes", async () => {
    const original = Array.from({ length: 30 }, () => message("original")).join("");
    const state = await fixture(original);
    const first = await readSessionConversationPage(sessionId, state);
    const middle = message("original").length * 15;
    await writeFile(state.file, original.slice(0, middle) + original.slice(middle).replace("original", "modified"));
    await utimes(state.file, new Date(), new Date(Date.now() + 1000));
    await expect(readSessionConversationPage(sessionId, { ...state, cursor: first.nextCursor })).rejects.toMatchObject({ reset: true });
  });

  it("keeps oversized records explicit and does not lose subsequent turns", async () => {
    const state = await fixture(message("x".repeat(8 * 1024 * 1024 + 1)) + message("following turn"));
    const page = await readSessionConversationPage(sessionId, { ...state, cursor: undefined });
    let forward = page;
    const texts = page.events.map((event) => event.text);
    while (forward.hasMore) {
      forward = await readSessionConversationPage(sessionId, { ...state, cursor: forward.nextCursor });
      texts.push(...forward.events.map((event) => event.text));
    }
    expect(texts).toContain("following turn");
    let before = page.previousCursor;
    let largeRecord = page.events.some((event) => event.type === "oversized.event");
    while (before) {
      const earlier = await readSessionConversationPage(sessionId, { ...state, before });
      largeRecord ||= earlier.events.some((event) => event.type === "oversized.event");
      before = earlier.previousCursor;
    }
    expect(largeRecord).toBe(true);
  });

  it("preserves tools and subagent messages without exposing session configuration", () => {
    expect(normalizeConversationEvent({ type: "assistant.message", agentId: "agent-1", data: { content: "Agent answer" } }, "source", 1))
      .toMatchObject({ role: "assistant", agentId: "agent-1", text: "Agent answer" });
    expect(normalizeConversationEvent({ type: "tool.execution_complete", data: { toolCallId: "call-1", success: false, result: { detailedContent: "Tool error" } } }, "source", 2))
      .toMatchObject({ role: "tool", toolCallId: "call-1", status: "failed", text: "Tool error" });
    expect(normalizeConversationEvent({ type: "session.start", data: { secret: "private" } }, "source", 0)?.text).toBe("");
  });

  it("correlates Steering only through the transport message ID carried in event data", () => {
    expect(normalizeConversationEvent({
      id: "unrelated-event-id",
      type: "user.message",
      data: { content: "Steered instruction", messageId: "transport-message-id" },
    }, "source", 0)).toMatchObject({
      sourceId: "unrelated-event-id",
      messageId: "transport-message-id",
      text: "Steered instruction",
    });
  });
});