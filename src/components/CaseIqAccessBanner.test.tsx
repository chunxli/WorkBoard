import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CaseIqAccessBanner from "./CaseIqAccessBanner";

function render(overrides: Partial<Parameters<typeof CaseIqAccessBanner>[0]> = {}) {
  return renderToStaticMarkup(<CaseIqAccessBanner label="SupportIQ sign-in" summary="Previously verified · 10 tools"
    busy={false} error={null} {...overrides}><button type="button">Existing authentication action</button></CaseIqAccessBanner>);
}

describe("compact theme-aware runtime access entries", () => {
  it("keeps the existing native disclosure closed and its controls mounted", () => {
    const markup = render();
    expect(markup).toContain('<details data-runtime-banner="">');
    expect(markup).not.toContain('<details data-runtime-banner="" open');
    expect(markup).toContain('aria-label="Toggle SupportIQ sign-in"');
    expect(markup).toContain("Existing authentication action");
    expect(markup).toContain("runtime-access-title");
    expect(markup).not.toContain("bg-white");
  });
  it("uses semantic theme tones rather than fixed utility colors on the summary", () => {
    const markup = render({ verified: true });
    expect(markup).toContain('class="runtime-access-status"');
    expect(markup).toContain('data-tone="verified"');
    expect(markup).not.toContain("text-emerald-400");
    expect(render()).toContain('data-tone="neutral"');
  });
  it("preserves the full status for assistive technology and truncated-text hover", () => {
    const markup = render({ summary: "A long current Session status with more detail than fits on a narrow screen" });
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('title="A long current Session status with more detail than fits on a narrow screen"');
  });
  it("keeps errors visible without opening or recoloring the whole card", () => {
    const markup = render({ error: "Synthetic refresh failure", verified: true });
    expect(markup).toContain('data-tone="error"');
    expect(markup).toContain("Needs attention");
    expect(markup).not.toContain('data-tone="verified"');
    expect(markup).not.toContain('<details data-runtime-banner="" open');
  });
  it("keeps busy feedback compact and respects reduced-motion preference", () => {
    const markup = render({ busy: true });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).toContain('width="12" height="12"');
  });
});
