import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const database = vi.hoisted(() => ({
  run: { findUniqueOrThrow: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  terminalLaunch: { findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  work: { update: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
vi.mock("@/lib/run-source-snapshot", () => ({
  captureRunSourceDiff: vi.fn(async () => ({ afterGitTree: null, diff: "test diff" })),
  isRunSourceBaselineReady: vi.fn(async () => false),
  inheritRunSourceBaseline: vi.fn(async () => null),
}));
vi.mock("@/lib/git-safety", () => ({ getHeadCommit: vi.fn(async () => null) }));

import { getTerminalSessionActivity, launchTerminalResume, reconcileTerminalRun, TerminalResumeInProgressError, TerminalResumeNotReadyError } from "./terminal-resume";
import { prepareWorkRunArtifacts, type WorkRunSnapshot } from "./run-artifacts";
import { captureRunSourceDiff, isRunSourceBaselineReady } from "./run-source-snapshot";
import { reconcileTerminalRuns } from "./terminal-launch-reaper";

let directory: string;
const sessionId = "12345678-1234-4234-8234-123456789abc";
const start = new Date("2026-10-14T10:00:00Z");
const repositoryRoot = process.cwd();

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "workboard-history-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.stubEnv("COPILOT_HOME", path.join(directory, "copilot"));
  database.run.findFirst.mockResolvedValue(null);
  database.work.update.mockResolvedValue({});
  database.$transaction.mockImplementation(async (operations: Promise<unknown>[]) => Promise.all(operations));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(history: string, cursor = 0) {
  const run = {
    id: "run-1", workId: "work-1", taskId: null, trigger: "TERMINAL_RESUME", status: "RUNNING",
    hostname: hostname(), copilotSessionId: sessionId, createdAt: start, executionPath: directory,
    task: null, work: { id: "work-1", directoryPath: directory, status: "ACTIVE" },
    resumedRuns: [] as { id: string }[],
  };
  const launch = {
    id: "launch-1", runId: run.id, status: "LAUNCHED", updatedAt: start,
    syncToken: null as string | null, syncOwnerPid: null as number | null,
    inactiveSince: null as Date | null, historySize: null as number | null,
    historyModifiedAt: null as Date | null, errorMessage: null as string | null,
  };
  database.run.findUniqueOrThrow.mockImplementation(async () => structuredClone(run));
  database.run.update.mockImplementation(async ({ data }) => Object.assign(run, data));
  database.terminalLaunch.findUniqueOrThrow.mockImplementation(async () => structuredClone(launch));
  database.terminalLaunch.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.syncToken !== launch.syncToken) return { count: 0 };
    Object.assign(launch, data);
    return { count: 1 };
  });
  const snapshot: WorkRunSnapshot = {
    schemaVersion: 1, runId: run.id, workId: run.workId, workName: "Test", promptFileName: "PROMPT.md",
    prompt: "Continue", promptHash: "hash", engine: "CLI", sessionId, executionPath: directory,
    concurrencyMode: "EXTERNAL_TERMINAL", status: "RUNNING", startedAt: start.toISOString(),
    finishedAt: null, exitCode: null, errorMessage: null, gitBeforeTree: null, gitAfterTree: null,
    sessionEventCursorStart: cursor,
  };
  const paths = await prepareWorkRunArtifacts(directory, run.id, snapshot);
  const sessionDirectory = path.join(directory, "copilot", "session-state", sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  const eventsPath = path.join(sessionDirectory, "events.jsonl");
  await writeFile(eventsPath, history);
  const lockPath = path.join(sessionDirectory, `inuse.${process.pid}.lock`);
  return { run, launch, paths, eventsPath, lockPath };
}

const response = '{"type":"assistant.message","data":{"content":"Done"}}\n';
const firstTick = new Date(start.getTime() + 60_000);
const secondTick = new Date(start.getTime() + 120_000);

describe("terminal minute history reconciliation", () => {
  it("creates and launches a new continuation after its previous Terminal wrapper has exited", async () => {
    const state = await fixture(response);
    state.run.createdAt = new Date();
    const exited = await promisify(execFile)(process.execPath, ["-p", "process.pid"]);
    const launchDirectory = path.join(directory, "data", "terminal-launches");
    await mkdir(launchDirectory, { recursive: true });
    await writeFile(path.join(launchDirectory, "launch-1.json"), JSON.stringify({ wrapperPid: Number(exited.stdout.trim()) }));
    vi.mocked(isRunSourceBaselineReady).mockResolvedValueOnce(true);
    database.run.create.mockResolvedValue({});
    database.terminalLaunch.create.mockResolvedValue({});
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() }) as unknown as ChildProcess;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const resumed = await launchTerminalResume(state.run.id);

    expect(state.run.status).toBe("SUCCESS");
    expect(resumed).toMatchObject({ launcherPid: 12345 });
    expect(resumed.runId).not.toBe(state.run.id);
    expect(database.run.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: resumed.runId, copilotSessionId: sessionId, resumedFromRunId: state.run.id, status: "RUNNING",
    }) });
    expect(spawn).toHaveBeenCalledWith("wt.exe", expect.arrayContaining(["--window", "new", "-LaunchFile"]), expect.any(Object));
  });

  it("rechecks an active-looking Run and still rejects a genuinely live session", async () => {
    const state = await fixture(response);
    await writeFile(state.lockPath, "");
    await expect(launchTerminalResume(state.run.id)).rejects.toBeInstanceOf(TerminalResumeInProgressError);
    expect(state.run.status).toBe("RUNNING");
    expect(captureRunSourceDiff).not.toHaveBeenCalled();
  });

  it("reconciles a stopped stale Run before checking its resume baseline", async () => {
    const state = await fixture(response);
    state.run.createdAt = new Date(Date.now() - 180_000);
    await expect(launchTerminalResume(state.run.id)).rejects.toBeInstanceOf(TerminalResumeNotReadyError);
    expect(state.run.status).toBe("SUCCESS");
    expect(captureRunSourceDiff).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a newly starting session for a stopped session during resume", async () => {
    const state = await fixture(response);
    state.run.createdAt = new Date();
    await expect(launchTerminalResume(state.run.id)).rejects.toBeInstanceOf(TerminalResumeInProgressError);
    expect(state.run.status).toBe("RUNNING");
    expect(captureRunSourceDiff).not.toHaveBeenCalled();
  });

  it("resumes a recently closed Terminal without waiting for the startup grace period", async () => {
    const state = await fixture(response);
    state.run.createdAt = new Date();
    const child = await promisify(execFile)(process.execPath, ["-p", "process.pid"]);
    const launchDirectory = path.join(directory, "data", "terminal-launches");
    await mkdir(launchDirectory, { recursive: true });
    await writeFile(path.join(launchDirectory, "launch-1.json"), JSON.stringify({ wrapperPid: Number(child.stdout.trim()) }));
    await expect(getTerminalSessionActivity(sessionId, state.launch.id)).resolves.toEqual({
      active: false, wrapperExited: true, exitCode: null, starting: false,
    });
    await expect(launchTerminalResume(state.run.id)).rejects.toBeInstanceOf(TerminalResumeNotReadyError);
    expect(state.run.status).toBe("SUCCESS");
    expect(captureRunSourceDiff).toHaveBeenCalledTimes(1);
  });

  it("keeps a live wrapper active even before the CLI writes its session lock", async () => {
    const state = await fixture(response);
    const launchDirectory = path.join(directory, "data", "terminal-launches");
    await mkdir(launchDirectory, { recursive: true });
    const launchFile = path.join(launchDirectory, "launch-1.json");
    await writeFile(launchFile, JSON.stringify({ wrapperPid: process.pid }));
    await expect(getTerminalSessionActivity(sessionId, state.launch.id)).resolves.toMatchObject({ active: true });
    await writeFile(launchFile, JSON.stringify({ wrapperPid: process.pid, exitCode: 0 }));
    await expect(getTerminalSessionActivity(sessionId, state.launch.id)).resolves.toEqual({
      active: false, wrapperExited: false, exitCode: 0, starting: false,
    });
    await writeFile(state.lockPath, "");
    await expect(getTerminalSessionActivity(sessionId, state.launch.id)).resolves.toMatchObject({ active: true });
  });

  it("preserves old launch and Run records through the callback-removal migration", async () => {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const databasePath = path.join(directory, "migration.db");
    const sqlite = new Database(databasePath);
    try {
      const root = path.join(repositoryRoot, "prisma", "migrations");
      const migrations = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      for (const migration of migrations.filter((name) => name !== "20261014030000_periodic_terminal_history")) {
        sqlite.exec(await readFile(path.join(root, migration, "migration.sql"), "utf8"));
      }
      sqlite.exec(`INSERT INTO "User" ("id") VALUES ('legacy-user');
        INSERT INTO "Work" ("id", "userId", "name", "directoryPath", "canonicalPath", "updatedAt")
        VALUES ('legacy-work', 'legacy-user', 'Legacy', '/legacy', '/legacy', CURRENT_TIMESTAMP);
        INSERT INTO "Run" ("id", "trigger", "workId") VALUES ('legacy-run', 'TERMINAL_START', 'legacy-work');
        INSERT INTO "TerminalLaunch" ("id", "runId", "tokenHash", "status", "expiresAt", "updatedAt")
        VALUES ('legacy-launch', 'legacy-run', 'old-token-hash', 'LAUNCHED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);`);
      sqlite.exec(await readFile(path.join(root, "20261014030000_periodic_terminal_history", "migration.sql"), "utf8"));
      const launch = sqlite.prepare('SELECT * FROM "TerminalLaunch"').get();
      expect(launch).toMatchObject({ id: "legacy-launch", runId: "legacy-run", status: "LAUNCHED", syncToken: null });
      expect(launch).not.toHaveProperty("tokenHash");
      expect(launch).not.toHaveProperty("expiresAt");
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      const actualPrisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) });
      try {
        await actualPrisma.terminalLaunch.update({ where: { id: "legacy-launch" }, data: { errorMessage: null } });
        const persisted = await actualPrisma.terminalLaunch.findUniqueOrThrow({ where: { id: "legacy-launch" } });
        expect(await actualPrisma.terminalLaunch.updateMany({
          where: { id: persisted.id, updatedAt: persisted.updatedAt, syncToken: null },
          data: { syncToken: "test-owner", syncOwnerPid: process.pid },
        })).toEqual({ count: 1 });
        expect(await actualPrisma.terminalLaunch.updateMany({
          where: { id: persisted.id, updatedAt: persisted.updatedAt, syncToken: null },
          data: { syncToken: "other-owner" },
        })).toEqual({ count: 0 });
      } finally {
        await actualPrisma.$disconnect();
      }
      sqlite.exec('DELETE FROM "Run" WHERE "id" = \'legacy-run\'');
      expect(sqlite.prepare('SELECT count(*) AS total FROM "TerminalLaunch"').get().total).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it.skipIf(process.platform !== "win32")("persists the real exit code through the Windows launcher without a callback", async () => {
    const launchFile = path.join(directory, "launch.json");
    await writeFile(launchFile, JSON.stringify({ workingDirectory: directory, sessionId, copilotArgs: ["--resume", sessionId] }));
    const script = path.join(repositoryRoot, "scripts", "workboard-resume.ps1").replaceAll("'", "''");
    const quotedLaunch = launchFile.replaceAll("'", "''");
    const command = `function global:copilot { $global:LASTEXITCODE = 7 }; & '${script}' -LaunchFile '${quotedLaunch}'; exit $LASTEXITCODE`;
    await expect(promisify(execFile)("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]))
      .rejects.toMatchObject({ code: 7 });
    const saved = JSON.parse(await readFile(launchFile, "utf8"));
    expect(saved).toMatchObject({ sessionId, exitCode: 7 });
    expect(saved.wrapperPid).toBeGreaterThan(0);
    expect(saved).not.toHaveProperty("callbackToken");
    await expect(readFile(`${launchFile}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues scanning other sessions after a read failure", async () => {
    const reconcile = vi.fn(async (runId: string) => {
      if (runId === "unreadable") throw new Error("file unavailable");
    });
    const onError = vi.fn();
    await reconcileTerminalRuns({
      listRuns: async () => [{ id: "running" }, { id: "unreadable" }, { id: "unknown" }],
      reconcile, onError,
    });
    expect(reconcile.mock.calls).toEqual([["running"], ["unreadable"], ["unknown"]]);
    expect(onError).toHaveBeenCalledWith("unreadable", expect.any(Error));
  });

  it("allows only one concurrent instance to claim a Run", async () => {
    const state = await fixture(response);
    await Promise.all([reconcileTerminalRun(state.run.id, firstTick), reconcileTerminalRun(state.run.id, firstTick)]);
    expect(database.run.update).toHaveBeenCalledTimes(1);
    expect(state.launch.syncToken).toBeNull();
  });

  it("checkpoints an active session without completing it and scopes resumed history", async () => {
    const state = await fixture(`{"type":"user.message","data":{"content":"old"}}\n${response}{"type":`, 1);
    await writeFile(state.lockPath, "");
    await reconcileTerminalRun(state.run.id, firstTick);
    await reconcileTerminalRun(state.run.id, secondTick);
    expect(state.run.status).toBe("RUNNING");
    expect(await readFile(state.paths.stdout, "utf8")).toBe(response);
    expect(await readFile(state.paths.transcript, "utf8")).toBe(response);
    expect(captureRunSourceDiff).not.toHaveBeenCalled();
    expect(state.launch.syncToken).toBeNull();
  });

  it("waits for a stable stopped observation then recovers completion without inventing an exit code", async () => {
    const state = await fixture(response);
    await reconcileTerminalRun(state.run.id, firstTick);
    expect(state.run.status).toBe("RUNNING");
    await reconcileTerminalRun(state.run.id, secondTick);
    expect(state.run).toMatchObject({ status: "SUCCESS", exitCode: null });
    expect(state.launch.status).toBe("COMPLETED");
    expect(captureRunSourceDiff).toHaveBeenCalledTimes(1);
  });

  it("preserves an incomplete stopped session as UNKNOWN and does not repeatedly finalize it", async () => {
    const state = await fixture('{"type":"user.message","data":{"content":"Do work"}}\n');
    await reconcileTerminalRun(state.run.id, firstTick);
    await reconcileTerminalRun(state.run.id, secondTick);
    expect(state.run.status).toBe("UNKNOWN");
    await reconcileTerminalRun(state.run.id, new Date(start.getTime() + 180_000));
    expect(captureRunSourceDiff).toHaveBeenCalledTimes(1);
  });

  it("revisits UNKNOWN when complete history arrives later", async () => {
    const state = await fixture('{"type":"user.message"}\n');
    await reconcileTerminalRun(state.run.id, firstTick);
    await reconcileTerminalRun(state.run.id, secondTick);
    expect(state.run.status).toBe("UNKNOWN");
    await writeFile(state.eventsPath, `{"type":"user.message"}\n${response}`);
    await reconcileTerminalRun(state.run.id, new Date(start.getTime() + 180_000));
    await reconcileTerminalRun(state.run.id, new Date(start.getTime() + 240_000));
    expect(state.run.status).toBe("SUCCESS");
  });

  it("keeps the latest unanswered prompt from reusing an older completion", async () => {
    const state = await fixture(`${response}{"type":"user.message","data":{"content":"Next task"}}\n`);
    await reconcileTerminalRun(state.run.id, firstTick);
    await reconcileTerminalRun(state.run.id, secondTick);
    expect(state.run.status).toBe("UNKNOWN");
  });

  it("preserves a nonzero exit code and only removes launch metadata after settlement", async () => {
    const state = await fixture(response);
    const launchDirectory = path.join(directory, "data", "terminal-launches");
    await mkdir(launchDirectory, { recursive: true });
    const launchFile = path.join(launchDirectory, "launch-1.json");
    await writeFile(launchFile, '{"exitCode":7}');
    await reconcileTerminalRun(state.run.id, firstTick);
    expect(await readFile(launchFile, "utf8")).toContain("exitCode");
    await reconcileTerminalRun(state.run.id, secondTick);
    expect(state.run).toMatchObject({ status: "FAILED", exitCode: 7 });
    await expect(readFile(launchFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not steal synchronization from a live owner process", async () => {
    const state = await fixture(response);
    state.launch.syncToken = "other-instance";
    state.launch.syncOwnerPid = process.pid;
    await reconcileTerminalRun(state.run.id, firstTick);
    expect(database.terminalLaunch.updateMany).not.toHaveBeenCalled();
  });

  it("freezes old Run history once another Run has resumed the session", async () => {
    const state = await fixture(response);
    state.run.resumedRuns.push({ id: "next-run" });
    await reconcileTerminalRun(state.run.id, firstTick);
    expect(database.terminalLaunch.updateMany).not.toHaveBeenCalled();
  });

  it("does not mix prior history into a Run after session truncation", async () => {
    const state = await fixture(response, 2);
    await expect(reconcileTerminalRun(state.run.id, firstTick)).rejects.toThrow("truncated");
    expect(state.run.status).toBe("RUNNING");
    expect(state.launch.syncToken).toBeNull();
  });

  it("does not reopen or finalize a Run when its history is corrupt", async () => {
    const state = await fixture('{broken}\n');
    await expect(reconcileTerminalRun(state.run.id, firstTick)).rejects.toThrow("invalid JSON");
    expect(database.run.update).not.toHaveBeenCalled();
    expect(state.launch.syncToken).toBeNull();
  });
});