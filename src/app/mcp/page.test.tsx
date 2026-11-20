import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), redirect: vi.fn(), run: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findFirst: mocks.run } } }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect, notFound: mocks.notFound, usePathname: () => "/work/example",
}));
import McpPage from "./page";
import NavLinks from "@/components/NavLinks";
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue("owner");
  mocks.redirect.mockImplementation((url: string) => { throw new Error(`redirect:${url}`); });
  mocks.notFound.mockImplementation(() => { throw new Error("not-found"); });
});
describe("Work-scoped MCP configuration navigation", () => {
  it("requires the same website authentication as Settings", async () => {
    mocks.user.mockResolvedValue(null);
    await expect(McpPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/api/auth/signin");
  });
  it("redirects an old Work/session bookmark to that Work's MCP panel", async () => {
    await expect(McpPage({ searchParams: Promise.resolve({ workId: "work", sessionId: "exact-session" }) }))
      .rejects.toThrow("redirect:/work/work?panel=mcp&sessionId=exact-session");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("sends an unscoped legacy link to the Work list instead of a global MCP page", async () => {
    await expect(McpPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/work");
  });
  it("resolves old Run bookmarks through owned metadata, not the current representative Run", async () => {
    mocks.run.mockResolvedValue({ workId: "own-work", copilotSessionId: "original-session" });
    await expect(McpPage({ searchParams: Promise.resolve({ runId: "old-run" }) }))
      .rejects.toThrow("redirect:/work/own-work?panel=mcp&sessionId=original-session");
    expect(mocks.run).toHaveBeenCalledWith({
      where: { id: "old-run", engine: "CASEIQ", providerId: "caseiq", work: { userId: "owner" } },
      select: { workId: true, copilotSessionId: true },
    });
  });
  it("does not redirect a foreign or mismatched Run into another Work's settings", async () => {
    mocks.run.mockResolvedValue(null);
    await expect(McpPage({ searchParams: Promise.resolve({ workId: "work", runId: "foreign", sessionId: "sid" }) }))
      .rejects.toThrow("not-found");
    expect(mocks.run.mock.calls[0][0].where).toMatchObject({ workId: "work", copilotSessionId: "sid", work: { userId: "owner" } });
  });
  it("removes the global MCP nav entry while retaining Work and Settings", () => {
    const markup = renderToStaticMarkup(<NavLinks />);
    expect(markup).not.toContain('href="/mcp"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('href="/settings"');
    expect(markup).toContain('href="/work"');
  });
});
