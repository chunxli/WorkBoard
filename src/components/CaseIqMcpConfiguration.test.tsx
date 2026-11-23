import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseIqMcpSessionEntry } from "@/lib/caseiq-options";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[], permissions: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T | ((current: T) => T)) => {
      hooks.states[index] = typeof next === "function" ? (next as (value: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
vi.mock("@/components/CaseIqToolPermissionsPanel", () => ({
  useCaseIqToolPermissions: hooks.permissions,
  CaseIqToolPermissionsPanel: () => <p>Expanded current Session approvals</p>,
}));
import CaseIqMcpConfiguration from "./CaseIqMcpConfiguration";
import { caseIqMcpConfigurationHref } from "@/lib/caseiq-options";

const own = "00000000-0000-4000-8000-000000000001";
const older = "00000000-0000-4000-8000-000000000002";
const foreign = "00000000-0000-4000-8000-000000000003";
function entry(workId: string, sessionId: string, overrides: Partial<CaseIqMcpSessionEntry> = {}): CaseIqMcpSessionEntry {
  return { workId, sessionId, workName: `${workId} name`, runId: `${sessionId}-representative`,
    createdAt: "2026-11-10T00:00:00.000Z", ready: true, reason: null, ...overrides };
}
const fetchIndex = vi.fn<typeof fetch>();
let cleanup: (() => void) | void;
beforeEach(() => {
  hooks.states = []; hooks.cursor = 0; hooks.effects = [];
  hooks.permissions.mockReset().mockReturnValue({ busy: null });
  cleanup = undefined;
  fetchIndex.mockReset().mockResolvedValue(new Response(JSON.stringify({
    sessions: [entry("other-work", foreign), entry("own-work", own), entry("own-work", older)],
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchIndex);
});
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); });
function render(workId = "own-work", initialSessionId: string | null = own) {
  hooks.cursor = 0;
  return renderToStaticMarkup(<CaseIqMcpConfiguration workId={workId} initialSessionId={initialSessionId} />);
}
async function load(workId = "own-work", initialSessionId: string | null = own) {
  render(workId, initialSessionId);
  cleanup = hooks.effects[0]();
  await vi.waitFor(() => expect(hooks.states[2]).toBe(false));
  return render(workId, initialSessionId);
}

describe("Work Detail MCP configuration", () => {
  it("renders current Work sessions only, with no global Work picker or policy writes", async () => {
    const markup = await load();
    expect(markup).toContain('aria-label="Work MCP configuration"');
    expect(markup).toContain(own);
    expect(markup).toContain(older);
    expect(markup).not.toContain(foreign);
    expect(markup).not.toContain("other-work");
    expect(markup).not.toContain("Find a Work");
    expect(markup).toContain("Expanded current Session approvals");
    expect(hooks.permissions).toHaveBeenLastCalledWith("own-work", `${own}-representative`, true);
    expect(fetchIndex).toHaveBeenCalledWith("/api/caseiq/mcp-sessions", expect.objectContaining({ cache: "no-store" }));
    expect(fetchIndex).toHaveBeenCalledTimes(1);
  });
  it("selects this Work's first session rather than the first global catalog entry", async () => {
    await load("own-work", null);
    expect(hooks.permissions).toHaveBeenLastCalledWith("own-work", `${own}-representative`, true);
  });
  it("does not fall back to another Session when an explicit link is unavailable", async () => {
    const markup = await load("own-work", foreign);
    expect(markup).toContain("requested Session is unavailable for this Work");
    expect(markup).not.toContain("Expanded current Session approvals");
    expect(hooks.permissions).toHaveBeenLastCalledWith("own-work", null, false);
  });
  it("preserves an explicitly requested historical Session", async () => {
    await load("own-work", older);
    expect(hooks.permissions).toHaveBeenLastCalledWith("own-work", `${older}-representative`, true);
    render("own-work", own);
    expect(hooks.permissions).toHaveBeenLastCalledWith("own-work", `${own}-representative`, true);
  });
  it("does not carry the previous Work's editable policy into a new Work render", async () => {
    await load();
    const markup = render("other-work", foreign);
    expect(markup).not.toContain("Expanded current Session approvals");
    expect(markup).not.toContain(own);
    expect(hooks.permissions).toHaveBeenLastCalledWith("other-work", null, false);
  });
  it("keeps unavailable Session evidence visible without enabling approvals", async () => {
    fetchIndex.mockResolvedValueOnce(new Response(JSON.stringify({
      sessions: [entry("own-work", own, { ready: false, reason: "Synthetic original binding is unavailable." })],
    }), { status: 200 }));
    const markup = await load();
    expect(markup).toContain("Synthetic original binding is unavailable");
    expect(hooks.permissions).toHaveBeenLastCalledWith("own-work", `${own}-representative`, false);
  });
  it("links empty Work configuration back to Settings without inventing a Session", async () => {
    fetchIndex.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    const markup = await load();
    expect(markup).toContain("No CaseIQ web sessions for this Work yet");
    expect(markup).toContain('href="/settings#mcp-defaults"');
    expect(hooks.permissions).toHaveBeenLastCalledWith("own-work", null, false);
  });
  it("preserves the Work and exact Session in an encoded detail-panel URL", () => {
    expect(caseIqMcpConfigurationHref("own-work", older)).toBe(`/work/own-work?panel=mcp&sessionId=${older}`);
    expect(caseIqMcpConfigurationHref("own-work")).toBe("/work/own-work?panel=mcp");
  });
});
