import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
import CaseIqDocsPage from "./page";
import CaseIqBridgeDocsPage from "./bridge/page";
import { caseIqDocumentationHref } from "@/lib/caseiq-docs";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.redirect.mockImplementation(() => { throw new Error("signin redirect"); });
});

describe("dedicated CaseIQ integration document", () => {
  it("renders the Markdown capability, blocker and fallback documentation", async () => {
    const markup = renderToStaticMarkup(await CaseIqDocsPage());
    expect(markup).toContain("CaseIQ 集成说明");
    expect(markup).toContain("scope-assist");
    expect(markup).toContain("SafeWright");
    expect(markup).toContain("Web Execute");
    expect(markup).toContain("回退");
    expect(markup).toContain("SkipUpdates");
  });

  it("requires authentication before reading the document", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(CaseIqDocsPage()).rejects.toThrow("signin redirect");
    expect(mocks.redirect).toHaveBeenCalledWith("/api/auth/signin");
  });

  it.each([
    { name: "integration", page: CaseIqDocsPage },
    { name: "bridge", page: CaseIqBridgeDocsPage },
  ])("renders $name with working local anchors, one page title and copyable code", async ({ page }) => {
    const markup = renderToStaticMarkup(await page());
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const anchors = [...markup.matchAll(/href="#([^"]+)"/g)].map((match) => decodeURIComponent(match[1]));
    expect(anchors.length).toBeGreaterThan(2);
    for (const anchor of anchors) expect(ids, `missing anchor ${anchor}`).toContain(anchor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    const articleTag = markup.match(/<article\b[^>]*>/)?.[0];
    expect(articleTag).toContain(":scroll-mt-48");
    expect(articleTag).toContain(":scroll-mt-24");
    expect(markup).toContain('id="docs-top" class="scroll-mt-48');
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain('href="/docs#caseiq-guides"');
    expect(markup).toContain('href="/docs/caseiq/bridge"');
    expect(markup).toContain("Web Prompt and Follow Up");
    expect(markup).not.toContain("Native Terminal only");
  });

  it("maps repository-relative Markdown links to authenticated web pages", () => {
    expect(caseIqDocumentationHref("caseiq-native-bridge.md#private-protocol")).toBe("/docs/caseiq/bridge#private-protocol");
    expect(caseIqDocumentationHref("./caseiq-integration.md#当前状态摘要")).toBe("/docs/caseiq#当前状态摘要");
    expect(caseIqDocumentationHref("#local")).toBe("#local");
    expect(caseIqDocumentationHref("https://example.test/reference")).toBe("https://example.test/reference");
  });

  it("requires authentication for the technical bridge guide too", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(CaseIqBridgeDocsPage()).rejects.toThrow("signin redirect");
    expect(mocks.redirect).toHaveBeenCalledWith("/api/auth/signin");
  });
});
