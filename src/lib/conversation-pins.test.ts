import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { readPinTarget, pinContentHash, pinLineText } from "./conversation-pins";
import { normalizeConversationEvent, readSessionConversationPage } from "./session-conversation";

const sessionId = "12345678-1234-4234-8234-123456789abc";
const directories: string[] = [];
const message = (text: string) => `${JSON.stringify({ id: "source-event", type: "assistant.message", data: { content: text } })}\n`;
async function fixture(content: string) {
  const baseDirectory = await mkdtemp(path.join(tmpdir(), "workboard-pins-"));
  directories.push(baseDirectory);
  const directory = path.join(baseDirectory, "session-state", sessionId);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "events.jsonl");
  await writeFile(file, content);
  return { baseDirectory, file };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("verified Pin history anchors", () => {
  it("loads an old pinned event directly, preserving exact UTF-8 byte offsets and navigable adjacent pages", async () => {
    const first = message("Earlier \u4e2d\u6587 paragraph");
    const text = "Pinned paragraph\n\n```xml\n  <sample />\n```";
    const state = await fixture(first + message(text) + message("later".repeat(70_000)));
    const offset = Buffer.byteLength(first);
    const page = await readSessionConversationPage(sessionId, { ...state, atOffset: offset, pageBytes: 64 });
    const event = page.events[0];
    const pin = { eventId: event.id, line: 4, contentHash: pinContentHash(event) };
    const target = await readPinTarget(sessionId, pin, { ...state, pageBytes: 64 });
    expect(target.text).toBe("  <sample />");
    expect(target.event.offset).toBe(offset);
    expect(target.page.hasEarlier).toBe(true);
    expect(target.page.hasMore).toBe(true);
    const earlier = await readSessionConversationPage(sessionId, { ...state, before: target.page.previousCursor!, pageBytes: 64 });
    expect(earlier.events[0].text).toBe("Earlier \u4e2d\u6587 paragraph");
    await appendFile(state.file, message("new output"));
    expect((await readPinTarget(sessionId, pin, state)).event.id).toBe(event.id);
  });

  it("rejects replaced, truncated and same-offset edited history rather than locating a different line", async () => {
    const state = await fixture(message("Original output"));
    const original = (await readSessionConversationPage(sessionId, state)).events[0];
    const pin = { eventId: original.id, line: 1, contentHash: pinContentHash(original) };
    await writeFile(state.file, message("Modified output"));
    await expect(readPinTarget(sessionId, pin, state)).rejects.toMatchObject({ status: 409 });
    await rename(state.file, `${state.file}.old`);
    await writeFile(state.file, message("Original output"));
    await expect(readPinTarget(sessionId, pin, state)).rejects.toMatchObject({ status: 409 });
    await writeFile(state.file, "");
    await expect(readPinTarget(sessionId, pin, state)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects out-of-range, non-boundary and unsafe positions and explicitly reports missing history", async () => {
    const state = await fixture(message("Output"));
    const page = await readSessionConversationPage(sessionId, state);
    await expect(readSessionConversationPage(sessionId, { ...state, atOffset: 2 })).rejects.toMatchObject({ status: 409 });
    await expect(readSessionConversationPage(sessionId, { ...state, atOffset: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(readSessionConversationPage(sessionId, { ...state, atOffset: 0, before: page.nextCursor })).rejects.toMatchObject({ status: 400 });
    await expect(readPinTarget(sessionId, { eventId: `${"a".repeat(64)}:9007199254740992`, line: 1 }, state)).rejects.toMatchObject({ status: 400 });
    await expect(readPinTarget(sessionId, { eventId: page.events[0].id, eventOffset: 100, line: 1 }, state)).rejects.toMatchObject({ status: 400 });
    await rm(state.file);
    await expect(readPinTarget(sessionId, { eventId: page.events[0].id, line: 1 }, state)).rejects.toMatchObject({ status: 404 });
  });

  it("accepts only non-empty lines of retained assistant output", () => {
    const assistant = normalizeConversationEvent({ type: "assistant.message", data: { content: "First\r\n\r\n  code" } }, "source", 0)!;
    expect(pinLineText(assistant, 3)).toBe("  code");
    expect(() => pinLineText(assistant, 2)).toThrow("non-empty line");
    expect(() => pinLineText(assistant, 99)).toThrow("non-empty line");
    expect(() => pinLineText({ ...assistant, role: "user" }, 1)).toThrow("assistant output");
  });
});

describe("Pin database migration and persistence", () => {
  it("preserves Work/Run data, enforces one Pin per source line, survives reconnect and cascades only with its Work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workboard-pin-db-"));
    directories.push(root);
    const databasePath = path.join(root, "pins.db");
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const sqlite = new Database(databasePath);
    const migrationRoot = path.join(process.cwd(), "prisma", "migrations");
    try {
      const migrations = (await readdir(migrationRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      for (const migration of migrations.filter((name) => name !== "20261103110000_work_conversation_pins")) {
        sqlite.exec(await readFile(path.join(migrationRoot, migration, "migration.sql"), "utf8"));
      }
      sqlite.exec(`INSERT INTO "User" ("id") VALUES ('pin-owner');
        INSERT INTO "Work" ("id", "userId", "name", "directoryPath", "canonicalPath", "updatedAt")
        VALUES ('pin-work', 'pin-owner', 'Pins', 'C:\\synthetic', 'C:\\synthetic', CURRENT_TIMESTAMP);
        INSERT INTO "Run" ("id", "workId", "trigger", "status") VALUES ('existing-run', 'pin-work', 'WORK', 'SUCCESS');`);
      sqlite.exec(await readFile(path.join(migrationRoot, "20261103110000_work_conversation_pins", "migration.sql"), "utf8"));
      expect(sqlite.prepare('SELECT "status" FROM "Run" WHERE "id" = ?').get("existing-run")).toEqual({ status: "SUCCESS" });
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally { sqlite.close(); }
    const createClient = () => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) });
    const first = createClient();
    let pinId: string;
    try {
      const data = { workId: "pin-work", sessionId, eventId: `${"a".repeat(64)}:3000000000`, eventOffset: 3_000_000_000,
        line: 4, contentHash: "b".repeat(64), preview: "<sample />", timestamp: null };
      const saved = await first.workConversationPin.create({ data });
      pinId = saved.id;
      const retried = await first.workConversationPin.upsert({
        where: { workId_sessionId_eventId_line: { workId: data.workId, sessionId, eventId: data.eventId, line: 4 } }, create: data, update: {},
      });
      expect(retried.id).toBe(pinId);
      expect(await first.workConversationPin.count()).toBe(1);
    } finally { await first.$disconnect(); }
    const reopened = createClient();
    try {
      const pins = await reopened.workConversationPin.findMany({ where: { workId: "pin-work", sessionId } });
      expect(pins).toHaveLength(1);
      expect(pins[0]).toMatchObject({ id: pinId, line: 4, preview: "<sample />", eventOffset: 3_000_000_000 });
      expect(await reopened.workConversationPin.findMany({ where: { workId: "pin-work", sessionId: "other-session" } })).toEqual([]);
      await reopened.work.delete({ where: { id: "pin-work" } });
      expect(await reopened.workConversationPin.count()).toBe(0);
    } finally { await reopened.$disconnect(); }
  });
});
