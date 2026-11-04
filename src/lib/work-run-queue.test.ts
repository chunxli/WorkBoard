import { describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue";
import { getWorkQueueBlockedReason, getWorkRunQueueKey, orderPendingWorkRuns } from "./work-run-queue";

const createdAt = new Date("2026-11-03T00:00:00Z");
const row = (id: string, resumedFromRunId: string | null = null) => ({
  id, resumedFromRunId, createdAt, trigger: "FOLLOW_UP", hostname: null, copilotSessionId: "same-session",
});

describe("Work queue identity and recovery ordering", () => {
  it("shares an initial Run's session key with all its follow-ups and preserves independent sessions", () => {
    expect(getWorkRunQueueKey({ ...row("initial"), trigger: "WORK" })).toBe(getWorkRunQueueKey(row("next", "initial")));
    expect(getWorkRunQueueKey({ ...row("other"), copilotSessionId: "other-session" })).toBe("session:other-session");
    expect(getWorkRunQueueKey({ id: "legacy", copilotSessionId: null })).toBe("legacy");
  });

  it("orders parent chains before children even with equal timestamps and out-of-order database results", () => {
    const initial = row("initial");
    const first = row("first", initial.id);
    const second = row("second", first.id);
    expect(orderPendingWorkRuns([second, first, initial]).map(({ id }) => id)).toEqual(["initial", "first", "second"]);
  });

  it("does not impose an artificial queue limit or exhaust the stack on long parent chains", () => {
    const records = Array.from({ length: 20_000 }, (_, index) => row(String(index), index ? String(index - 1) : null));
    const ordered = orderPendingWorkRuns(records.reverse());
    expect(ordered).toHaveLength(20_000);
    expect(ordered.every((run, index) => run.id === String(index))).toBe(true);
  });

  it("surfaces corrupt cyclic dependencies instead of skipping messages", () => {
    expect(() => orderPendingWorkRuns([row("first", "second"), row("second", "first")])).toThrow("Cyclic queued follow-up dependency");
  });

  it("admits only a verified single managed Work session", () => {
    expect(getWorkQueueBlockedReason([row("first"), row("second")], "same-session", "local")).toBeNull();
    expect(getWorkQueueBlockedReason([], "same-session", "local")).not.toBeNull();
    expect(getWorkQueueBlockedReason([row("first")], null, "local")).not.toBeNull();
    expect(getWorkQueueBlockedReason([{ ...row("first"), hostname: "foreign" }], "same-session", "local")).toContain("another machine");
    expect(getWorkQueueBlockedReason([{ ...row("first"), trigger: "TERMINAL_RESUME" }], "same-session", "local")).toContain("Terminal");
    expect(getWorkQueueBlockedReason([{ ...row("first"), experimentVariantId: "variant" }], "same-session", "local")).toContain("experiments");
    expect(getWorkQueueBlockedReason([{ ...row("first"), copilotSessionId: "other" }], "same-session", "local")).toContain("other Work session");
  });
});

describe("queued messages after terminal Run states", () => {
  it.each(["SUCCESS", "FAILED", "CANCELLED", "TIMED_OUT"])("keeps FIFO and one active message after %s", async (terminalStatus) => {
    const queue = new JobQueue(2);
    const gate = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let parentStatus = "RUNNING";
    const failure = new Error("Synthetic failed parent");
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      queue.enqueue(getWorkRunQueueKey({ ...row("parent"), trigger: "WORK" }), async () => {
        starts.push("parent");
        maximumActive = Math.max(maximumActive, ++active);
        await gate.promise;
        parentStatus = terminalStatus;
        active--;
        if (terminalStatus === "FAILED") throw failure;
      });
      for (const id of ["first", "second"]) {
        queue.enqueue(getWorkRunQueueKey(row(id)), async () => {
          expect(parentStatus).toBe(terminalStatus);
          maximumActive = Math.max(maximumActive, ++active);
          starts.push(id);
          active--;
          if (id === "second") completed.resolve();
        });
      }
      queue.enqueue("independent-session", async () => { starts.push("independent"); });
      expect(starts).toEqual(["parent", "independent"]);
      gate.resolve();
      await completed.promise;
      expect(starts).toEqual(["parent", "independent", "first", "second"]);
      expect(maximumActive).toBe(1);
      if (terminalStatus === "FAILED") expect(logger).toHaveBeenCalledWith("[job-queue] job failed:", failure);
    } finally {
      gate.resolve();
      logger.mockRestore();
    }
  });
});
