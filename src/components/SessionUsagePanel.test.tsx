import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SessionUsagePanel from "./SessionUsagePanel";

const usage = {
  mcp: [{ name: "example-long-mcp-server-name", count: 13, failedCount: 2 }],
  skills: [{ name: "case-triage", count: 1 }],
  partial: false,
};

describe("Session usage panel", () => {
  it("shows grouped names and exact accessible counts in the expanded desktop shelf", () => {
    const markup = renderToStaticMarkup(<SessionUsagePanel usage={usage} expanded />);
    expect(markup).toContain('aria-label="Session usage"');
    expect(markup).toContain('<details open="">');
    expect(markup).toContain('aria-label="MCP"');
    expect(markup).toContain('aria-label="Skills"');
    expect(markup).toContain('title="example-long-mcp-server-name"');
    expect(markup).toContain("case-triage");
    expect(markup).toContain('13<span class="sr-only"> total calls</span>');
    expect(markup).toContain('1<span class="sr-only"> total call</span>');
    expect(markup).toContain("Total (failed)");
    expect(markup).toContain('text-red-400" title="2 failed calls"><span aria-hidden="true">(2)</span>');
    expect(markup).toContain(', 2 failed calls</span>');
  });

  it("keeps the narrow shelf collapsed with totals available in its summary", () => {
    const markup = renderToStaticMarkup(<SessionUsagePanel usage={usage} />);
    expect(markup).toContain("<details>");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Session usage <span");
    expect(markup).toContain("MCP 13");
    expect(markup.split("</summary>")[0]).toContain('title="2 failed calls"');
    expect(markup).toContain("Skills 1");
  });

  it("does not imply success or display a red zero when no explicit failures were recorded", () => {
    const markup = renderToStaticMarkup(<SessionUsagePanel usage={{
      ...usage, mcp: [{ name: "waiting", count: 3, failedCount: 0 }],
    }} expanded />);
    expect(markup).toContain("Total recorded calls, not successful calls");
    expect(markup).not.toContain("text-red-400");
    expect(markup).not.toContain("Total (failed)");
  });

  it("distinguishes no calls from unavailable and partial history", () => {
    const empty = renderToStaticMarkup(<SessionUsagePanel usage={{ mcp: [], skills: [], partial: false }} expanded />);
    expect(empty.match(/None recorded/g)).toHaveLength(2);
    const unavailable = renderToStaticMarkup(<SessionUsagePanel usage={null} expanded />);
    expect(unavailable).toContain("Session usage is unavailable.");
    expect(unavailable).not.toContain("None recorded");
    const partial = renderToStaticMarkup(<SessionUsagePanel usage={{ ...usage, partial: true }} expanded />);
    expect(partial).toContain("Some session records could not be counted.");
    expect(partial).toContain("case-triage");
  });

  it("lets the desktop sidebar shelf auto-size to full content until constrained by the section tabs above", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const desktopBlock = css.slice(css.indexOf("@media (min-width: 1024px)"));
    expect(desktopBlock).toContain("flex-shrink: 0;");
    expect(desktopBlock).toContain(".work-conversation-sidebar .work-session-usage-content");
    expect(desktopBlock).toContain("max-height: none;");
    expect(desktopBlock).toContain("overflow: visible;");
    expect(desktopBlock).not.toContain("max-height: min(36dvh, 18rem);");
  });
});
