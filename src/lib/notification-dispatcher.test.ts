import { describe, expect, it, vi } from "vitest";
import {
  dispatchPendingSystemNotifications,
  resolveExperimentNotificationStatus,
  type ExperimentNotificationCandidate,
  type NotificationDispatcherDependencies,
  type RunNotificationCandidate,
} from "./notification-dispatcher";

const finishedAt = new Date("2026-09-03T10:00:00.000Z");

function runCandidate(overrides: Partial<RunNotificationCandidate> = {}): RunNotificationCandidate {
  return {
    id: "run-12345678",
    status: "SUCCESS",
    trigger: "WORK",
    startedAt: new Date("2026-09-03T09:55:00.000Z"),
    finishedAt,
    experimentVariantId: null,
    model: "gpt-main",
    modelsUsed: JSON.stringify(["gpt-main", "gpt-reviewer"]),
    inputTokens: 12_000,
    outputTokens: 345,
    work: { userId: "user-work", name: "Investigate incident" },
    task: null,
    ...overrides,
  };
}

function experimentCandidate(
  statuses: string[],
  overrides: Partial<ExperimentNotificationCandidate> = {}
): ExperimentNotificationCandidate {
  return {
    id: "experiment-1",
    name: "Skill comparison",
    status: "COMPLETED",
    finishedAt,
    errorMessage: null,
    work: { userId: "user-work" },
    variants: statuses.map((status) => ({ runs: [{ status }] })),
    ...overrides,
  };
}

function createDependencies(options: {
  runs?: RunNotificationCandidate[];
  experiments?: ExperimentNotificationCandidate[];
  enabled?: boolean;
  notifyError?: Error;
} = {}) {
  const claimedRuns = new Set<string>();
  const claimedExperiments = new Set<string>();
  const runOutcomes: Array<{ id: string; outcome: string; error?: string }> = [];
  const experimentOutcomes: Array<{ id: string; outcome: string; error?: string }> = [];
  const notify = vi.fn(async () => {
    if (options.notifyError) throw options.notifyError;
  });
  const dependencies: NotificationDispatcherDependencies = {
    now: () => finishedAt,
    notify,
    listRunCandidates: async () => options.runs ?? [],
    claimRun: async (id) => {
      if (claimedRuns.has(id)) return false;
      claimedRuns.add(id);
      return true;
    },
    completeRun: async (id, outcome, _completedAt, error) => {
      runOutcomes.push({ id, outcome, error });
    },
    listExperimentCandidates: async () => options.experiments ?? [],
    claimExperiment: async (id) => {
      if (claimedExperiments.has(id)) return false;
      claimedExperiments.add(id);
      return true;
    },
    completeExperiment: async (id, outcome, _completedAt, error) => {
      experimentOutcomes.push({ id, outcome, error });
    },
    notificationsEnabled: async () => options.enabled ?? true,
  };
  return { dependencies, notify, runOutcomes, experimentOutcomes };
}

describe("system notification dispatcher", () => {
  it("claims a Run once across concurrent dispatchers and uses Task ownership first", async () => {
    const run = runCandidate({
      task: { name: "Nightly review", repo: { userId: "user-automation" } },
    });
    const state = createDependencies({ runs: [run] });

    await Promise.all([
      dispatchPendingSystemNotifications(state.dependencies),
      dispatchPendingSystemNotifications(state.dependencies),
    ]);

    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith({
      title: "Automation completed",
      message: expect.stringContaining("Nightly review | Run run-1234 | 5m 0s | gpt-main, gpt-reviewer | 12.3K tokens"),
    });
    expect(state.runOutcomes).toEqual([{ id: run.id, outcome: "sent", error: undefined }]);
  });

  it("suppresses cancelled and experiment variant Runs", async () => {
    const cancelled = runCandidate({ id: "cancelled", status: "CANCELLED" });
    const variant = runCandidate({
      id: "variant",
      trigger: "EXPERIMENT",
      experimentVariantId: "variant-1",
    });
    const state = createDependencies({ runs: [cancelled, variant] });

    await dispatchPendingSystemNotifications(state.dependencies);

    expect(state.notify).not.toHaveBeenCalled();
    expect(state.runOutcomes.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
      { id: "cancelled", outcome: "suppressed" },
      { id: "variant", outcome: "suppressed" },
    ]);
  });

  it("suppresses disabled notifications and records notifier errors without retrying", async () => {
    const disabled = createDependencies({ runs: [runCandidate()], enabled: false });
    await dispatchPendingSystemNotifications(disabled.dependencies);
    expect(disabled.notify).not.toHaveBeenCalled();
    expect(disabled.runOutcomes[0]?.outcome).toBe("suppressed");

    const failed = createDependencies({
      runs: [runCandidate()],
      notifyError: new Error("notifications unavailable"),
    });
    await dispatchPendingSystemNotifications(failed.dependencies);
    await dispatchPendingSystemNotifications(failed.dependencies);
    expect(failed.notify).toHaveBeenCalledTimes(1);
    expect(failed.runOutcomes).toEqual([{
      id: "run-12345678",
      outcome: "error",
      error: "notifications unavailable",
    }]);
  });

  it("aggregates Experiment outcomes and waits for terminal variants", () => {
    expect(resolveExperimentNotificationStatus(experimentCandidate(["SUCCESS", "SUCCESS"])))
      .toBe("SUCCESS");
    expect(resolveExperimentNotificationStatus(experimentCandidate(["SUCCESS", "TIMED_OUT"])))
      .toBe("TIMED_OUT");
    expect(resolveExperimentNotificationStatus(experimentCandidate(["TIMED_OUT", "FAILED"])))
      .toBe("FAILED");
    expect(resolveExperimentNotificationStatus(experimentCandidate(["SUCCESS", "CANCELLED"])))
      .toBe("SUPPRESSED");
    expect(resolveExperimentNotificationStatus(experimentCandidate(["SUCCESS", "RUNNING"])))
      .toBeNull();
    expect(resolveExperimentNotificationStatus(experimentCandidate([], { status: "FAILED" })))
      .toBe("FAILED");
  });

  it("emits one aggregate Experiment notification", async () => {
    const experiment = experimentCandidate(["SUCCESS", "SUCCESS"]);
    const state = createDependencies({ experiments: [experiment] });

    await dispatchPendingSystemNotifications(state.dependencies);

    expect(state.notify).toHaveBeenCalledOnce();
    expect(state.notify).toHaveBeenCalledWith({
      title: "Experiment completed",
      message: "Skill comparison | 2 variants",
    });
    expect(state.experimentOutcomes).toEqual([{
      id: experiment.id,
      outcome: "sent",
      error: undefined,
    }]);
  });
});
