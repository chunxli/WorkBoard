import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ lines: ["Retained streamed output"], finished: false }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [typeof initial === "function" ? state.lines : state.finished, vi.fn()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import LiveRunLog from "./LiveRunLog";

beforeEach(() => {
  state.lines = ["Retained streamed output"];
  state.finished = false;
});

describe("Run output with independently refreshed status", () => {
  it("uses the final server log and removes Live output when metadata finishes first", () => {
    const markup = renderToStaticMarkup(
      <LiveRunLog runId="status-run" initialLog="Final persisted output" isLive={false} refreshOnStatusChange={false} />,
    );
    expect(markup).toContain("Final persisted output");
    expect(markup).not.toContain("Retained streamed output");
    expect(markup).not.toContain("Live output");
  });

  it("does not replace active streamed lines with an older server snapshot", () => {
    const markup = renderToStaticMarkup(
      <LiveRunLog runId="status-run" initialLog="Older snapshot" isLive refreshOnStatusChange={false} />,
    );
    expect(markup).toContain("Retained streamed output");
    expect(markup).toContain("Live output");
    expect(markup).not.toContain("Older snapshot");
  });

  it("retains polled history for UNKNOWN without claiming live execution", () => {
    const markup = renderToStaticMarkup(
      <LiveRunLog runId="status-run" initialLog="Older snapshot" isLive={false} historySync refreshOnStatusChange={false} />,
    );
    expect(markup).toContain("Retained streamed output");
    expect(markup).not.toContain("Live output");
  });
});
