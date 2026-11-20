import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PendingRunFeedback from "./PendingRunFeedback";

describe("Pending Run feedback", () => {
  it("shows waiting without asserting an unobserved preparation step", () => {
    const markup = renderToStaticMarkup(<PendingRunFeedback />);
    expect(markup).toContain("Waiting to start");
    expect(markup).toContain("No preparation step has been reported yet.");
    expect(markup).not.toContain("files scanned");
  });

  it("shows measured scan progress and does not invent a total or an ETA", () => {
    const markup = renderToStaticMarkup(<PendingRunFeedback preparation={{
      phase: "snapshot", progress: { filesScanned: 42, bytesRead: 16_200_000_000 },
    }} />);
    expect(markup).toContain("Scanning workspace files");
    expect(markup).toContain("42 files scanned · 16.2 GB read");
    expect(markup).toContain("Copilot has not started for this Run.");
    expect(markup).not.toContain("progressbar");
    expect(markup).not.toContain("remaining");
  });
});
