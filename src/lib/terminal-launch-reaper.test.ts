import { describe, expect, it, vi } from "vitest";
import {
  reapExpiredTerminalRuns,
  type ExpiredTerminalLaunch,
  type TerminalLaunchReaperDependencies,
} from "./terminal-launch-reaper";
import { parseTerminalLaunchExitCode } from "./terminal-resume";

const updatedAt = new Date("2026-09-03T11:00:00.000Z");

function expiredLaunch(id: string, runId: string): ExpiredTerminalLaunch {
  return { id, runId, updatedAt };
}

function createReaper(candidates: ExpiredTerminalLaunch[]) {
  const claimed = new Set<string>();
  const finalizeRun = vi.fn(async () => true);
  const removeLaunchFile = vi.fn(async () => undefined);
  const dependencies: TerminalLaunchReaperDependencies = {
    now: () => new Date("2026-09-03T12:00:00.000Z"),
    listExpired: async () => candidates,
    claimExpired: async (launch) => {
      if (claimed.has(launch.id)) return false;
      claimed.add(launch.id);
      return true;
    },
    finalizeRun,
    readExitCode: async () => null,
    syncExpiredRun: async () => undefined,
    removeLaunchFile,
  };
  return { dependencies, finalizeRun, removeLaunchFile };
}

describe("terminal launch reaper", () => {
  it("reads a persisted terminal exit status and rejects an unknown outcome", () => {
    expect(parseTerminalLaunchExitCode('\uFEFF{"exitCode":7}')).toBe(7);
    expect(() => parseTerminalLaunchExitCode('{"sessionId":"session"}'))
      .toThrow("exit status is unavailable");
  });

  it("terminalizes expired Runs even when the launch file is already absent", async () => {
    const launch = expiredLaunch("launch-1", "run-1");
    const state = createReaper([launch]);
    state.removeLaunchFile.mockRejectedValueOnce(new Error("missing"));

    await expect(reapExpiredTerminalRuns(state.dependencies)).resolves.toBe(1);

    expect(state.finalizeRun).toHaveBeenCalledWith(
      "run-1",
      "Terminal callback token expired",
      new Date("2026-09-03T12:00:00.000Z")
    );
    expect(state.removeLaunchFile).toHaveBeenCalledWith("launch-1");
  });

  it("allows only one concurrent reaper to claim a launch", async () => {
    const state = createReaper([expiredLaunch("launch-1", "run-1")]);

    const results = await Promise.all([
      reapExpiredTerminalRuns(state.dependencies),
      reapExpiredTerminalRuns(state.dependencies),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(state.finalizeRun).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the database query excludes active or syncing launches", async () => {
    const state = createReaper([]);

    await expect(reapExpiredTerminalRuns(state.dependencies)).resolves.toBe(0);
    expect(state.finalizeRun).not.toHaveBeenCalled();
  });

  it("can retry a claimed launch when the Run is still active", async () => {
    const launch = expiredLaunch("launch-1", "run-1");
    let finalizationAttempts = 0;
    const dependencies: TerminalLaunchReaperDependencies = {
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      listExpired: async () => [launch],
      claimExpired: async () => true,
      finalizeRun: async () => {
        finalizationAttempts += 1;
        if (finalizationAttempts === 1) throw new Error("database unavailable");
        return true;
      },
      removeLaunchFile: async () => undefined,
      readExitCode: async () => null,
      syncExpiredRun: async () => undefined,
    };

    await expect(reapExpiredTerminalRuns(dependencies)).rejects.toThrow("database unavailable");
    await expect(reapExpiredTerminalRuns(dependencies)).resolves.toBe(1);
    expect(finalizationAttempts).toBe(2);
  });

  it("synchronizes an expired launch when its terminal exit status was persisted", async () => {
    const launch = expiredLaunch("launch-1", "run-1");
    const syncExpiredRun = vi.fn(async () => undefined);
    const finalizeRun = vi.fn(async () => true);
    const removeLaunchFile = vi.fn(async () => undefined);
    const dependencies: TerminalLaunchReaperDependencies = {
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      listExpired: async () => [launch],
      claimExpired: async () => true,
      finalizeRun,
      readExitCode: async () => 0,
      syncExpiredRun,
      removeLaunchFile,
    };

    await expect(reapExpiredTerminalRuns(dependencies)).resolves.toBe(1);
    expect(syncExpiredRun).toHaveBeenCalledWith("run-1", 0);
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(removeLaunchFile).toHaveBeenCalledWith("launch-1");
  });
});
