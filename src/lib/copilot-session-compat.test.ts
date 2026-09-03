import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copilotSessionExists,
  readCompatibleCopilotSessionEvents,
  repairLegacyCopilotSessionEvents,
  upgradeLegacyPermissionEvent,
  upgradeLegacySessionContent,
} from "./copilot-session-compat";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))
  );
});

async function createSession(content: string) {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "workboard-session-compat-"));
  cleanupPaths.push(baseDirectory);
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const sessionDirectory = path.join(baseDirectory, "session-state", sessionId);
  const eventsPath = path.join(sessionDirectory, "events.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(eventsPath, content, "utf8");
  return { baseDirectory, sessionId, sessionDirectory, eventsPath };
}

describe("Copilot session compatibility", () => {
  it("distinguishes persisted sessions from allocated-only IDs", async () => {
    const session = await createSession('{"type":"session.start"}\n');

    await expect(copilotSessionExists(session.sessionId, session.baseDirectory)).resolves.toBe(true);
    await rm(session.eventsPath);
    await expect(copilotSessionExists(session.sessionId, session.baseDirectory)).resolves.toBe(false);
  });

  it("maps legacy permission transitions in both directions", () => {
    const enabled = upgradeLegacyPermissionEvent({
      type: "session.permissions_changed",
      data: { previousMode: "manual", mode: "allow-all" },
    });
    expect(enabled).toEqual({
      changed: true,
      event: {
        type: "session.permissions_changed",
        data: {
          previousAllowAllPermissions: false,
          allowAllPermissions: true,
          previousAllowAllPermissionMode: "off",
          allowAllPermissionMode: "on",
        },
      },
    });

    const disabled = upgradeLegacyPermissionEvent({
      type: "session.permissions_changed",
      data: { previousMode: "allow-all", mode: "manual" },
    });
    expect(disabled.event).toMatchObject({
      data: {
        previousAllowAllPermissions: true,
        allowAllPermissions: false,
        previousAllowAllPermissionMode: "on",
        allowAllPermissionMode: "off",
      },
    });
  });

  it("reports malformed JSON with its line number", () => {
    expect(() => upgradeLegacySessionContent('{"type":"session.start"}\n{bad json}\n')).toThrow(
      "invalid JSON at line 2"
    );
  });

  it("backs up and atomically repairs a session only once", async () => {
    const original = [
      JSON.stringify({ type: "session.start", data: { sessionId: "test" } }),
      JSON.stringify({
        type: "session.permissions_changed",
        data: { previousMode: "manual", mode: "allow-all" },
      }),
      "",
    ].join("\n");
    const session = await createSession(original);

    const repaired = await repairLegacyCopilotSessionEvents(
      session.sessionId,
      session.baseDirectory
    );
    expect(repaired.repairedEvents).toBe(1);
    expect(repaired.eventCount).toBe(2);
    expect(repaired.backupPath).not.toBeNull();
    expect(await readFile(repaired.backupPath!, "utf8")).toBe(original);

    const events = await readCompatibleCopilotSessionEvents(
      session.sessionId,
      session.baseDirectory
    );
    expect(events[1]).toMatchObject({
      data: { previousAllowAllPermissions: false, allowAllPermissions: true },
    });
    await expect(
      repairLegacyCopilotSessionEvents(session.sessionId, session.baseDirectory)
    ).resolves.toEqual({ repairedEvents: 0, backupPath: null, eventCount: 2 });
  });

  it("refuses to rewrite a session held by a live process", async () => {
    const session = await createSession(
      `${JSON.stringify({
        type: "session.permissions_changed",
        data: { previousMode: "manual", mode: "allow-all" },
      })}\n`
    );
    await writeFile(path.join(session.sessionDirectory, `inuse.${process.pid}.lock`), "", "utf8");

    await expect(
      repairLegacyCopilotSessionEvents(session.sessionId, session.baseDirectory)
    ).rejects.toThrow("still active");
    expect(await readFile(session.eventsPath, "utf8")).toContain('"previousMode":"manual"');
  });
});