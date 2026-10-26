import { describe, expect, it, vi } from "vitest";
import {
  dispatchPendingSystemNotifications,
  buildRunSystemNotification,
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
    work: { id: "work-1", userId: "user-work", name: "Investigate incident" },
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
    work: { id: "work-1", userId: "user-work" },
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
  it("targets the exact Work or the Automation's linked Work while preserving owner precedence", () => {
    expect(buildRunSystemNotification(runCandidate())?.notification.destination).toEqual({ kind: "work", id: "work-1" });
    const linked = buildRunSystemNotification(runCandidate({
      task: { name: "Linked review", workId: "automation-work", repo: { userId: "automation-owner" } },
    }));
    expect(linked?.userId).toBe("automation-owner");
    expect(linked?.notification.destination).toEqual({ kind: "work", id: "automation-work" });
  });

  it.each(["SUCCESS", "FAILED", "TIMED_OUT"])("keeps %s explicit and excludes missing metrics and Run-ID clutter", (status) => {
    const built = buildRunSystemNotification(runCandidate({
      status, startedAt: null, model: null, modelsUsed: null, inputTokens: null, outputTokens: null,
    }));
    expect(built?.notification.title).toBe(`Work ${status === "SUCCESS" ? "completed" : status === "FAILED" ? "failed" : "timed out"}`);
    expect(built?.notification.details).toBe("");
    expect(built?.notification.message).not.toContain("Run run-");
  });

  it("bounds long Work/model labels and counts distinct additional models", () => {
    const model = "long-model-".repeat(20);
    const prepared = buildRunSystemNotification(runCandidate({
      work: { id: "work-1", userId: "user-work", name: "👩‍💻".repeat(130) },
      modelsUsed: JSON.stringify([" ", model, model, "short-model"]),
    }));
    expect([...new Intl.Segmenter().segment(prepared?.notification.message ?? "")]).toHaveLength(100);
    expect(prepared?.notification.message.endsWith("…")).toBe(true);
    expect((prepared?.notification.details?.length ?? 0)).toBeLessThanOrEqual(100);
    expect(prepared?.notification.details).not.toContain(" | Run ");
    expect(prepared?.notification.details).toContain("+1");
  });

  it("deduplicates model names without inventing missing telemetry", () => {
    const prepared = buildRunSystemNotification(runCandidate({
      modelsUsed: JSON.stringify(["gpt-main", " gpt-main ", "", "gpt-second"]),
    }));
    expect(prepared?.notification.details).toBe("5m 0s · gpt-main +1 · 12.3K tokens");
  });

  it("claims a Run once across concurrent dispatchers and uses Task ownership first", async () => {
    const run = runCandidate({
      task: { name: "Nightly review", workId: null, repo: { userId: "user-automation" } },
    });
    const state = createDependencies({ runs: [run] });

    await Promise.all([
      dispatchPendingSystemNotifications(state.dependencies),
      dispatchPendingSystemNotifications(state.dependencies),
    ]);

    expect(state.notify).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith({
      title: "Automation completed",
      message: "Nightly review",
      details: "5m 0s · gpt-main +1 · 12.3K tokens",
      destination: { kind: "run", id: run.id },
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
      message: "Skill comparison",
      details: "2 variants",
      destination: { kind: "work", id: "work-1" },
    });
    expect(state.experimentOutcomes).toEqual([{
      id: experiment.id,
      outcome: "sent",
      error: undefined,
    }]);
  });
});
