import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), activity: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findMany: mocks.findMany } } }));
vi.mock("@/lib/terminal-resume", () => ({
  getTerminalSessionActivity: mocks.activity, reconcileTerminalRun: mocks.reconcile,
}));

import { startTerminalHistorySync } from "./terminal-launch-reaper";

const state = globalThis as typeof globalThis & { terminalHistoryTimer?: NodeJS.Timeout; terminalHistoryPending?: Promise<void> };
const createdAt = new Date("2026-11-19T02:00:00Z");
const candidate = (id: string, inactiveSince: Date | null = null) => ({
  id, createdAt, copilotSessionId: `${id}-session`, terminalLaunches: [{ id: `${id}-launch`, inactiveSince }],
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(createdAt);
  mocks.reconcile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  delete state.terminalHistoryTimer;
  delete state.terminalHistoryPending;
  vi.useRealTimers();
});

describe("Terminal settlement scheduling", () => {
  it("checks stopped Runs every two seconds but checkpoints active and UNKNOWN history only on the minute sweep", async () => {
    mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING"
      ? [candidate("live"), candidate("starting"), candidate("stopped"), candidate("reopened", createdAt)]
      : [{ id: "live" }, { id: "late-unknown" }]);
    mocks.activity.mockImplementation(async (session: string) => ({
      active: ["live-session", "reopened-session"].includes(session), starting: session === "starting-session",
    }));

    startTerminalHistorySync();
    startTerminalHistorySync();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mocks.findMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: expect.objectContaining({ status: "RUNNING", resumedRuns: { none: {} }, OR: [{ hostname: hostname() }, { hostname: null }] }),
      select: {
        id: true, copilotSessionId: true, createdAt: true,
        terminalLaunches: { select: { id: true, inactiveSince: true }, take: 1 },
      },
    }));
    expect(mocks.reconcile.mock.calls).toEqual([
      ["stopped", new Date(createdAt.getTime() + 2_000), { stoppedOnly: true }],
      ["reopened", new Date(createdAt.getTime() + 2_000), { stoppedOnly: true }],
    ]);

    await vi.advanceTimersByTimeAsync(58_000);
    expect(mocks.reconcile.mock.calls.filter((args) => args.length === 1)).toEqual([["live"], ["late-unknown"]]);
    expect(mocks.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["RUNNING", "UNKNOWN"] } }),
    }));
  });

  it("does not overlap scans and still runs a checkpoint due during a slow stop check", async () => {
    let finish!: (runs: []) => void;
    mocks.findMany.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValue([]);

    startTerminalHistorySync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    finish([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    expect(mocks.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["RUNNING", "UNKNOWN"] } }),
    }));
  });
});
