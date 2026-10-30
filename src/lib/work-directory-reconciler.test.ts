import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRunStartLock } from "./run-start-lock";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(), stat: vi.fn(), list: vi.fn(), update: vi.fn(), activity: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat, stat: mocks.stat }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { findMany: mocks.list, updateMany: mocks.update } } }));
vi.mock("@/lib/terminal-resume", () => ({ getTerminalSessionActivity: mocks.activity }));
import { reconcileMissingWorkDirectories, startWorkDirectoryReconciliation } from "./work-directory-reconciler";

const directoryPath = path.resolve("missing-work-directory-fixture");
const rootPath = path.parse(directoryPath).root;
const updatedAt = new Date("2026-10-30T06:00:00Z");
const work = {
  id: "missing-work", directoryPath, updatedAt, archivedAt: null,
  runs: [{ copilotSessionId: "fixture-session", terminalLaunches: [{ id: "fixture-launch" }] }],
};
const missing = () => Object.assign(new Error("Fixture path is missing"), { code: "ENOENT" });
const timerState = globalThis as typeof globalThis & {
  workDirectoryTimer?: NodeJS.Timeout;
  workDirectoryPending?: Promise<void>;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([work]);
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.activity.mockResolvedValue({ active: false, starting: false });
  mocks.lstat.mockRejectedValue(missing());
  mocks.stat.mockResolvedValue({ isDirectory: () => true });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (timerState.workDirectoryTimer) clearInterval(timerState.workDirectoryTimer);
  delete timerState.workDirectoryTimer;
  delete timerState.workDirectoryPending;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("missing Work directory reconciliation", () => {
  it("archives only an unchanged idle Work without touching its files or history", async () => {
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: "owner", hostname: hostname(), status: { not: "ARCHIVED" },
        runs: { none: { status: { in: ["PENDING", "RUNNING"] } } },
      },
    }));
    expect(mocks.update).toHaveBeenCalledWith({
      where: {
        userId: "owner", hostname: hostname(), status: { not: "ARCHIVED" },
        runs: { none: { status: { in: ["PENDING", "RUNNING"] } } },
        id: work.id, directoryPath, updatedAt,
      },
      data: { status: "ARCHIVED", archivedAt: expect.any(Date) },
    });
    expect(mocks.activity).toHaveBeenCalledWith("fixture-session", "fixture-launch");
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("Archived Work missing-work"));
  });

  it("leaves an existing directory alone even if a child file or manifest is missing", async () => {
    mocks.lstat.mockResolvedValue({ isDirectory: () => true });
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.lstat).toHaveBeenCalledExactlyOnceWith(directoryPath);
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not mistake an existing symbolic link with an unavailable target for a deleted root", async () => {
    mocks.lstat.mockResolvedValue({ isSymbolicLink: () => true });
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR", "ETIMEDOUT"])("does not archive on %s and reports the failed check", async (code) => {
    mocks.lstat.mockRejectedValue(Object.assign(new Error("Fixture access error"), { code }));
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Could not verify or archive Work"), expect.any(Error));
  });

  it("does not archive when the drive or share root is unavailable", async () => {
    mocks.stat.mockRejectedValue(missing());
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.stat).toHaveBeenCalledWith(rootPath);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it.each([{ active: true, starting: false }, { active: false, starting: true }])("preserves a Terminal-owned Work: %j", async (activity) => {
    mocks.activity.mockResolvedValue(activity);
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not assume Terminal inactivity when the observation fails", async () => {
    mocks.activity.mockRejectedValue(new Error("Fixture process observation failed"));
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it.each(["work:missing-work", "session:fixture-session"])("does not race with an existing %s start lock", async (key) => {
    await withRunStartLock([key], () => reconcileMissingWorkDirectories("owner"));
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("checks all distinct session owners rather than only the newest session", async () => {
    mocks.list.mockResolvedValue([{ ...work, runs: [
      ...work.runs, ...work.runs, { copilotSessionId: "older-session", terminalLaunches: [] },
    ] }]);
    mocks.activity.mockImplementation(async (sessionId) => ({ active: sessionId === "older-session", starting: false }));
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.activity).toHaveBeenCalledTimes(2);
    expect(mocks.activity).toHaveBeenCalledWith("older-session", null);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rechecks the root before updating in case the folder has returned", async () => {
    let checks = 0;
    mocks.lstat.mockImplementation(async () => {
      if (++checks > 1) return { isDirectory: () => true };
      throw missing();
    });
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not report an archive if the guarded database update loses a race", async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    await reconcileMissingWorkDirectories("owner");
    expect(console.info).not.toHaveBeenCalled();
  });

  it("reports a failed update and continues checking other Works", async () => {
    mocks.list.mockResolvedValue([work, { ...work, id: "other-work", runs: [] }]);
    mocks.update.mockRejectedValueOnce(new Error("Fixture database write failed"));
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("Archived Work other-work"));
  });

  it("rejects relative paths rather than inspecting the server working directory", async () => {
    mocks.list.mockResolvedValue([{ ...work, directoryPath: "relative-folder" }]);
    await reconcileMissingWorkDirectories("owner");
    expect(mocks.lstat).not.toHaveBeenCalled();
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps background scans scoped to this host and excludes archived or busy Works", async () => {
    mocks.list.mockResolvedValue([]);
    await reconcileMissingWorkDirectories();
    expect(mocks.list.mock.calls[0][0].where).toEqual({
      hostname: hostname(), status: { not: "ARCHIVED" },
      runs: { none: { status: { in: ["PENDING", "RUNNING"] } } },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("detects actual folder deletion without recreating the missing root", async () => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const temporary = await fs.mkdtemp(path.join(tmpdir(), "work-directory-reconcile-"));
    const directoryPath = path.join(temporary, "work");
    try {
      await fs.mkdir(directoryPath);
      mocks.list.mockResolvedValue([{ ...work, directoryPath, runs: [] }]);
      mocks.lstat.mockImplementation(fs.lstat);
      mocks.stat.mockImplementation(fs.stat);
      await reconcileMissingWorkDirectories("owner");
      expect(mocks.update).not.toHaveBeenCalled();
      await fs.rmdir(directoryPath);
      await reconcileMissingWorkDirectories("owner");
      expect(mocks.update).toHaveBeenCalledOnce();
      await expect(fs.lstat(directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(directoryPath, { recursive: true, force: true });
      await fs.rmdir(temporary);
    }
  });

  it("starts one 30-second background timer and reports scan failures", async () => {
    vi.useFakeTimers();
    mocks.list.mockRejectedValue(new Error("Fixture scan failed"));
    startWorkDirectoryReconciliation();
    const timer = timerState.workDirectoryTimer;
    startWorkDirectoryReconciliation();
    expect(timerState.workDirectoryTimer).toBe(timer);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("[work-directory] Scan failed:", expect.any(Error));
  });

  it("does not overlap slow background scans", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    mocks.list.mockImplementation(() => new Promise<never[]>((resolve) => { release = () => resolve([]); }));
    startWorkDirectoryReconciliation();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.list).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});
