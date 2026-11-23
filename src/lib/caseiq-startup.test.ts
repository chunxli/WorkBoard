import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseIqStartupObservationSchema, type CaseIqStartupPhase } from "./caseiq-startup";
import { clearCaseIqStartup, getCaseIqStartup, reportCaseIqStartup } from "./caseiq-startup-state";
import { CopilotCompletionTracker } from "./copilot-completion";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T00:00:00.000Z"));
});
afterEach(() => {
  clearCaseIqStartup("startup-one"); clearCaseIqStartup("startup-two");
  vi.useRealTimers();
});

describe("current-Run coordinator startup evidence", () => {
  it("measures real stage changes without advancing a duplicate report or another Run", () => {
    reportCaseIqStartup("startup-one", "checking", 1);
    const first = getCaseIqStartup("startup-one")!;
    vi.advanceTimersByTime(15_000);
    reportCaseIqStartup("startup-one", "checking", 1);
    expect(getCaseIqStartup("startup-one")).toBe(first);
    reportCaseIqStartup("startup-two", "native", 1);
    reportCaseIqStartup("startup-one", "session", 1);
    expect(getCaseIqStartup("startup-one")).toMatchObject({
      phase: "session", attempt: 1, startedAt: first.startedAt, updatedAt: "2026-11-10T00:00:15.000Z",
      steps: [{ phase: "checking", at: first.startedAt }, { phase: "session", at: "2026-11-10T00:00:15.000Z" }],
    });
    expect(getCaseIqStartup("startup-two")?.phase).toBe("native");
  });

  it("resets elapsed time and old activity when the same Run starts a fallback/continuation attempt", () => {
    reportCaseIqStartup("startup-one", "processing", 1);
    vi.advanceTimersByTime(30_000);
    reportCaseIqStartup("startup-one", "checking", 2);
    expect(getCaseIqStartup("startup-one")).toEqual({
      phase: "checking", attempt: 2, startedAt: "2026-11-10T00:00:30.000Z", updatedAt: "2026-11-10T00:00:30.000Z",
      steps: [{ phase: "checking", at: "2026-11-10T00:00:30.000Z" }],
    });
  });

  it("bounds stage history and removes only the owned Run's evidence during cleanup", () => {
    const phases: CaseIqStartupPhase[] = ["checking", "session", "launcher", "accepted", "native", "processing", "stopping"];
    for (let index = 0; index < 21; index++) reportCaseIqStartup("startup-one", phases[index % phases.length], 1);
    reportCaseIqStartup("startup-two", "checking", 1);
    expect(getCaseIqStartup("startup-one")?.steps).toHaveLength(7);
    expect(caseIqStartupObservationSchema.safeParse({
      runId: "startup-one", status: "RUNNING", startedAt: new Date().toISOString(),
      startup: getCaseIqStartup("startup-one"), unavailableReason: null,
    }).success).toBe(true);
    clearCaseIqStartup("startup-one");
    expect(getCaseIqStartup("startup-one")).toBeNull();
    expect(getCaseIqStartup("startup-two")?.phase).toBe("checking");
  });

  it("shares evidence across Next route module instances without persisting it to disk", async () => {
    reportCaseIqStartup("startup-one", "accepted", 1);
    vi.resetModules();
    const anotherModule = await import("./caseiq-startup-state");
    expect(anotherModule.getCaseIqStartup("startup-one")).toEqual(getCaseIqStartup("startup-one"));
    anotherModule.clearCaseIqStartup("startup-one");
    expect(getCaseIqStartup("startup-one")).toBeNull();
  });
});

describe("native response activity, not launcher text or old history", () => {
  it("does not mistake metadata, a user Prompt or unstructured output for model activity", () => {
    const tracker = new CopilotCompletionTracker();
    tracker.push("CaseIQ assistant is ready\n");
    tracker.push(`${JSON.stringify({ type: "session.start", data: {} })}\n`);
    tracker.push(`${JSON.stringify({ type: "user.message", data: { content: "Synthetic Prompt" } })}\n`);
    expect(tracker.hasResponseActivity).toBe(false);
  });

  it.each(["assistant.turn_start", "assistant.message", "assistant.message_delta", "tool.execution_start"])(
    "waits for the complete current native %s frame",
    (type) => {
      const tracker = new CopilotCompletionTracker();
      const line = JSON.stringify({ type, data: { content: "Synthetic", toolCallId: "local-tool" } });
      tracker.push(line.slice(0, 12));
      expect(tracker.hasResponseActivity).toBe(false);
      tracker.push(`${line.slice(12)}\n`);
      expect(tracker.hasResponseActivity).toBe(true);
      expect(new CopilotCompletionTracker().hasResponseActivity).toBe(false);
    },
  );
});
