import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session";
import { docsNavigation, docsSections } from "@/lib/docs-content";
import DocsPage from "./page";

vi.mock("@/lib/session", () => ({ getSessionUserId: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("Redirected to sign-in"); }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUserId).mockResolvedValue("docs-user");
});

describe("in-app Docs Quick Start", () => {
  it("renders a prominent entry, matching navigation and both languages", async () => {
    const markup = renderToStaticMarkup(await DocsPage());
    expect(markup).toContain('href="#quick-start"');
    expect(markup).toContain('id="quick-start"');
    expect(markup).toContain("Quick Start &amp; Initial Setup");
    const quickStart = docsSections[0];
    expect(markup).toContain(quickStart.subtitle.zh);
    expect(markup).toContain(quickStart.subtitle.en);
    expect(markup).toContain('lang="zh-CN"');
    expect(markup).toContain('lang="en"');
  });

  it("renders readable command blocks and real initial-setup links", async () => {
    const markup = renderToStaticMarkup(await DocsPage());
    const commandBlocks = docsSections.flatMap((section) => section.features).filter((feature) => feature.code);
    expect(markup.match(/<pre\b/g)).toHaveLength(commandBlocks.length);
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("Set-Location .\\WorkBoard");
    expect(markup).toContain("Copy-Item .env.example .env");
    expect(markup).toContain("test -f .env || cp .env.example .env");
    expect(markup).toContain("npm ci\nnpm run background:start");
    for (const href of ["/settings#prompt-templates", "/settings", "/settings#execution-defaults", "/work"]) {
      expect(markup).toContain(`href="${href}"`);
    }
    expect(markup).toContain("Standard tools");
    expect(markup).toContain("Save defaults");
  });

  it("links both source-backed CaseIQ guides from matching navigation and cards", async () => {
    const markup = renderToStaticMarkup(await DocsPage());
    for (const section of docsNavigation) {
      const sectionTag = markup.match(new RegExp(`<section id="${section.id}"[^>]*>`))?.[0];
      expect(sectionTag).toContain("scroll-mt-48");
      expect(sectionTag).toContain("lg:scroll-mt-24");
    }
    expect(markup.indexOf('id="quick-start"')).toBeLessThan(markup.indexOf('id="caseiq-guides"'));
    expect(markup.indexOf('id="caseiq-guides"')).toBeLessThan(markup.indexOf('id="work-lifecycle"'));
    expect(markup).toContain('href="#caseiq-guides"');
    expect(markup).toContain('id="caseiq-guides"');
    expect(markup).toContain('href="/docs/caseiq"');
    expect(markup).toContain('href="/docs/caseiq/bridge"');
    expect(markup).toContain("CaseIQ integration");
    expect(markup).toContain("CaseIQ native bridge");
    expect(markup).toContain("Choose CaseIQ in Runtime");
    expect(markup).not.toContain("Native Terminal only");
  });

  it("preserves authentication requirements", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    await expect(DocsPage()).rejects.toThrow("Redirected to sign-in");
    expect(redirect).toHaveBeenCalledWith("/api/auth/signin");
  });
});
