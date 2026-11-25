import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CaseIqAccessBanner, { syncRuntimeBannerDisclosure } from "./CaseIqAccessBanner";

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
  it("auto-collapses once sign-in verification completes and Work is released, without closing later manual inspection", () => {
    const disclosure = { open: false };
    let state = { autoOpened: false, autoCollapsed: false };

    // Auto-opens when sign-in starts
    state = syncRuntimeBannerDisclosure({
      disclosure,
      revealKey: "signing-in",
      autoCollapse: false,
      wasAutoOpened: state.autoOpened,
      wasAutoCollapsed: state.autoCollapsed,
    });
    expect(disclosure.open).toBe(true);
    expect(state).toEqual({ autoOpened: true, autoCollapsed: false });

    // Stays open while OAuth is checked but Terminal is still open (revealKey="signing-in", autoCollapse=false)
    state = syncRuntimeBannerDisclosure({
      disclosure,
      revealKey: "signing-in",
      autoCollapse: false,
      wasAutoOpened: state.autoOpened,
      wasAutoCollapsed: state.autoCollapsed,
    });
    expect(disclosure.open).toBe(true);

    // Automatically collapses as soon as Terminal closes and verification settles
    state = syncRuntimeBannerDisclosure({
      disclosure,
      revealKey: null,
      autoCollapse: true,
      wasAutoOpened: state.autoOpened,
      wasAutoCollapsed: state.autoCollapsed,
    });
    expect(disclosure.open).toBe(false);
    expect(state).toEqual({ autoOpened: false, autoCollapsed: true });

    // If user manually opens the verified banner later, background refreshes do not force-close it
    disclosure.open = true;
    state = syncRuntimeBannerDisclosure({
      disclosure,
      revealKey: null,
      autoCollapse: true,
      wasAutoOpened: state.autoOpened,
      wasAutoCollapsed: state.autoCollapsed,
    });
    expect(disclosure.open).toBe(true);

    // Also auto-collapses if user manually opened an unverified banner and then refreshed into verified state
    const manualDisclosure = { open: true };
    const manualSettled = syncRuntimeBannerDisclosure({
      disclosure: manualDisclosure,
      revealKey: null,
      autoCollapse: true,
      wasAutoOpened: false,
      wasAutoCollapsed: false,
    });
    expect(manualDisclosure.open).toBe(false);
    expect(manualSettled).toEqual({ autoOpened: false, autoCollapsed: true });
  });
});
