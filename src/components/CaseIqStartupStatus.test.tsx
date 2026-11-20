import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseIqStartupFeedback } from "./CaseIqStartupStatus";
import type { CaseIqStartupObservation, CaseIqStartupPhase } from "@/lib/caseiq-startup";

const startedAt = "2026-11-10T00:00:00.000Z";
const now = Date.parse(startedAt) + 30_000;
function observation(phase: CaseIqStartupPhase): CaseIqStartupObservation {
  return {
    runId: "current-follow-up", status: "RUNNING", startedAt, unavailableReason: null,
    startup: { phase, attempt: 1, startedAt, updatedAt: startedAt, steps: [{ phase: "checking", at: startedAt }, { phase, at: startedAt }] },
  };
}
function render(value: CaseIqStartupObservation | null, error: string | null = null, toolActivityAt: readonly string[] = []) {
  return renderToStaticMarkup(<CaseIqStartupFeedback observation={value} error={error} now={now}
    onShowLogs={vi.fn()} onRetry={vi.fn()} toolActivityAt={toolActivityAt} />);
}

describe("CaseIQ current-Run startup feedback", () => {
  it.each(["checking", "session", "launcher", "accepted", "native", "processing"] as const)(
    "hands off %s feedback once a tool from this startup attempt is actually visible",
    (phase) => {
      expect(render(observation(phase), null, [new Date(Date.parse(startedAt) + 10_000).toISOString()])).toBe("");
    },
  );

  it("does not let earlier Session tools hide a new Follow Up's initialization", () => {
    const value = observation("session");
    value.runId = "new-follow-up";
    value.startedAt = new Date(Date.parse(startedAt) + 20_000).toISOString();
    value.startup!.startedAt = value.startedAt;
    const markup = render(value, null, [startedAt, new Date(Date.parse(startedAt) + 10_000).toISOString()]);
    expect(markup).toContain("Preparing the Session");
    expect(markup).toContain("animate-spin");
  });

  it("matches the current attempt rather than old tools from an earlier continuation in the same Run", () => {
    const value = observation("launcher");
    value.startup!.attempt = 2;
    value.startup!.startedAt = new Date(Date.parse(startedAt) + 20_000).toISOString();
    expect(render(value, null, [startedAt])).toContain("Initializing CaseIQ");
    expect(render(value, null, [new Date(Date.parse(startedAt) + 25_000).toISOString()])).toBe("");
  });

  it("does not infer handoff from missing/invalid tool timestamps or an unobserved startup attempt", () => {
    expect(render(observation("processing"), null, ["not-a-timestamp"])).toContain("CaseIQ is working");
    expect(render(null, null, [startedAt])).toContain("Checking CaseIQ startup");
  });

  it("keeps queued and stopping states even when the Session has tool records", () => {
    expect(render({ ...observation("checking"), status: "PENDING" }, null, [startedAt])).toContain("Checking the trusted runtime");
    expect(render(observation("stopping"), null, [startedAt])).toContain("Stopping CaseIQ");
  });

  it.each([startedAt, "2026-11-10T08:00:10.000+08:00"])(
    "accepts a tool at the attempt boundary or with an equivalent explicit timezone: %s",
    (timestamp) => expect(render(observation("processing"), null, [timestamp])).toBe(""),
  );

  it("keeps observation failures explicit after tools become visible", () => {
    const markup = render(observation("processing"), "Synthetic startup status check failed.", [startedAt]);
    expect(markup).toContain("Synthetic startup status check failed.");
    expect(markup).toContain("Retry check");
    expect(markup).not.toContain("animate-spin");
  });

  it("announces checking before its first snapshot rather than claiming that a model started", () => {
    const markup = render(null);
    expect(markup).toContain("Checking CaseIQ startup...");
    expect(markup).toContain("Earlier conversation messages do not hide its initialization");
    expect(markup).toContain('aria-label="CaseIQ Run startup status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("CaseIQ is working");
  });

  it.each(["checking", "session", "launcher", "accepted", "native"] as const)(
    "shows the actual %s stage, measured waiting time and a current-Run log action",
    (phase) => {
      const markup = render(observation(phase));
      expect(markup).toContain("30s");
      expect(markup).toContain("View startup logs");
      expect(markup).toContain("Reported startup stages");
      expect(markup).toContain("motion-reduce:animate-none");
      expect(markup).toContain("ui-subtle-button");
      expect(markup).not.toContain("ui-secondary-button");
      expect(markup).not.toContain('role="progressbar"');
      expect(markup).not.toContain("CaseIQ is working");
    },
  );

  it("does not equate native spawn with MCP readiness or sign-in verification", () => {
    const markup = render(observation("native"));
    expect(markup).toContain("may still be loading the Session/MCPs or waiting for model activity");
    expect(markup).not.toContain("connected");
    expect(markup).not.toContain("sign-in verified");
  });

  it("keeps working feedback for views without visible tool activity, including Raw output", () => {
    const markup = render(observation("processing"));
    expect(markup).toContain("CaseIQ is working on your Prompt");
    expect(markup).toContain("View Run output");
    expect(markup).not.toContain("Reported startup stages");
    expect(markup).not.toContain("Initializing CaseIQ");
  });

  it("shows cancellation as stopping, not another initialization attempt", () => {
    const markup = render(observation("stopping"));
    expect(markup).toContain("Stopping CaseIQ");
    expect(markup).toContain("stop safely");
    expect(markup).not.toContain("Reported startup stages");
  });

  it("shows a real queued state without asserting that the runtime has started", () => {
    const markup = render({ ...observation("checking"), status: "PENDING", startup: null });
    expect(markup).toContain("CaseIQ is queued");
    expect(markup).toContain("Waiting for this Run&#x27;s worker");
    expect(markup).not.toContain("CaseIQ is working");
  });

  it.each(["SUCCESS", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"])(
    "removes live animation and startup claims for terminal status %s",
    (status) => expect(render({ ...observation("native"), status })).toBe(""),
  );

  it("makes unknown/reconnect evidence explicit without inventing whether the Prompt was sent", () => {
    const markup = render({
      ...observation("checking"), startup: null,
      unavailableReason: "No live startup marker is available. The Run may already be executing.",
    });
    expect(markup).toContain("CaseIQ startup state unavailable");
    expect(markup).toContain("may already be executing");
    expect(markup).toContain("View startup logs");
    expect(markup).not.toContain("animate-spin");
    expect(markup).not.toContain("Prompt has not been sent");
  });

  it("surfaces observation failures rather than presenting a stale phase as live success", () => {
    const markup = render(observation("processing"), "Synthetic startup status check failed.");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Synthetic startup status check failed.");
    expect(markup).toContain("Retry check");
    expect(markup).not.toContain("CaseIQ is working on your Prompt");
    expect(markup).not.toContain("animate-spin");
  });

  it("measures a new continuation attempt from its own actual start", () => {
    const value = observation("session");
    value.startup!.attempt = 2;
    value.startup!.startedAt = new Date(now - 5000).toISOString();
    const markup = render(value);
    expect(markup).toContain("5s");
    expect(markup).toContain("Attempt 2 in the same Run/Session");
    expect(markup).not.toContain(">30s<");
  });
});
