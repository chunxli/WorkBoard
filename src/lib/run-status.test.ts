import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRunStatusSnapshot } from "./run-status";

const { activity, environment } = vi.hoisted(() => ({
  activity: vi.fn(),
  environment: { authMode: "local" },
}));
vi.mock("node:os", () => ({ hostname: () => "status-host" }));
vi.mock("@/lib/auth-mode", () => ({ get authMode() { return environment.authMode; } }));
vi.mock("@/lib/terminal-resume", () => ({ getTerminalSessionActivity: activity }));

const run = {
  id: "status-run", status: "RUNNING", trigger: "TERMINAL_RESUME",
  copilotSessionId: "status-session", hostname: "status-host",
  createdAt: new Date("2026-10-19T01:00:00Z"),
  terminalLaunches: [{ id: "status-launch", errorMessage: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  environment.authMode = "local";
  activity.mockResolvedValue({ active: false, starting: false });
});

describe("read-only Run activity snapshots", () => {
  it.each([
    { active: true, starting: false, displayStatus: "IN_TERMINAL", terminalActive: true },
    { active: false, starting: true, displayStatus: "IN_TERMINAL", terminalActive: true },
    { active: false, starting: false, displayStatus: "SYNCING", terminalActive: false },
  ])("derives $displayStatus from physical activity", async (state) => {
    activity.mockResolvedValue(state);
    expect(await getRunStatusSnapshot(run)).toEqual({
      id: run.id, status: "RUNNING", displayStatus: state.displayStatus,
      terminalActive: state.terminalActive, observationError: null,
    });
    expect(activity).toHaveBeenCalledWith(run.copilotSessionId, "status-launch", run.createdAt);
  });

  it.each(["SUCCESS", "FAILED", "CANCELLED", "TIMED_OUT", "UNKNOWN"])("preserves the finalized %s outcome", async (status) => {
    activity.mockResolvedValue({ active: true, starting: false });
    expect(await getRunStatusSnapshot({ ...run, status })).toMatchObject({
      status, displayStatus: status, terminalActive: null,
    });
    expect(activity).not.toHaveBeenCalled();
  });

  it("does not reuse a continuation's liveness for its old parent", async () => {
    await getRunStatusSnapshot({ ...run, resumedRuns: [{ id: "new-run" }] });
    expect(activity).not.toHaveBeenCalled();
  });

  it.each([
    { hostname: "another-machine", copilotSessionId: run.copilotSessionId },
    { hostname: run.hostname, copilotSessionId: null },
  ])("keeps unverified activity restricted", async (overrides) => {
    const snapshot = await getRunStatusSnapshot({ ...run, ...overrides });
    expect(snapshot.displayStatus).toBe("IN_TERMINAL");
    expect(snapshot.terminalActive).toBeNull();
    expect(snapshot.observationError).toBeTruthy();
    expect(activity).not.toHaveBeenCalled();
  });

  it("does not trust an unknown host outside local authentication mode", async () => {
    environment.authMode = "entra";
    const snapshot = await getRunStatusSnapshot({ ...run, hostname: null });
    expect(snapshot.terminalActive).toBeNull();
    expect(snapshot.observationError).toContain("could not be verified");
    expect(activity).not.toHaveBeenCalled();
  });

  it("surfaces activity errors instead of treating them as stopped", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    activity.mockRejectedValueOnce(new Error("Lock directory access denied"));
    try {
      const snapshot = await getRunStatusSnapshot(run);
      expect(snapshot.terminalActive).toBeNull();
      expect(snapshot.displayStatus).toBe("IN_TERMINAL");
      expect(snapshot.observationError).toContain("Lock directory access denied");
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("keeps synchronization failures visible without fabricating a final outcome", async () => {
    const snapshot = await getRunStatusSnapshot({
      ...run, terminalLaunches: [{ id: "status-launch", errorMessage: "Session history was truncated" }],
    });
    expect(snapshot).toMatchObject({
      status: "RUNNING", displayStatus: "SYNCING", terminalActive: false,
      observationError: "Session synchronization failed: Session history was truncated",
    });
  });
});
