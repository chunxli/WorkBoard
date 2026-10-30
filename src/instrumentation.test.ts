import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  keepAwake: vi.fn(), recovery: vi.fn(), terminalReconcile: vi.fn(), terminalStart: vi.fn(),
  directoryReconcile: vi.fn(), directoryStart: vi.fn(), notify: vi.fn(), notificationStart: vi.fn(), scheduler: vi.fn(),
}));
vi.mock("@/lib/keep-awake", () => ({ preventSystemSleep: mocks.keepAwake }));
vi.mock("@/lib/run-recovery", () => ({ recoverRuns: mocks.recovery }));
vi.mock("@/lib/terminal-launch-reaper", () => ({
  reconcileTerminalRuns: mocks.terminalReconcile, startTerminalHistorySync: mocks.terminalStart,
}));
vi.mock("@/lib/work-directory-reconciler", () => ({
  reconcileMissingWorkDirectories: mocks.directoryReconcile, startWorkDirectoryReconciliation: mocks.directoryStart,
}));
vi.mock("@/lib/notification-dispatcher", () => ({
  dispatchPendingSystemNotifications: mocks.notify, startSystemNotificationDispatcher: mocks.notificationStart,
}));
vi.mock("@/lib/scheduler", () => ({ startScheduler: mocks.scheduler }));
import { register } from "./instrumentation";

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Work directory background reconciliation startup", () => {
  it("reconciles once after Run recovery and Terminal settlement, then starts the periodic scan", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    expect(mocks.directoryReconcile).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.directoryStart).toHaveBeenCalledOnce();
    expect(mocks.terminalReconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.directoryReconcile.mock.invocationCallOrder[0]);
    expect(mocks.directoryReconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.directoryStart.mock.invocationCallOrder[0]);
    expect(mocks.directoryStart.mock.invocationCallOrder[0]).toBeLessThan(mocks.scheduler.mock.invocationCallOrder[0]);
  });

  it("does not start directory scans in non-Node runtimes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(mocks.directoryReconcile).not.toHaveBeenCalled();
    expect(mocks.directoryStart).not.toHaveBeenCalled();
  });
});
