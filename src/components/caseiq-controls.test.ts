import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCaseIqAuthentication } from "./CaseIqAuthenticationPanel";
import { useCaseIqToolPermissions } from "./CaseIqToolPermissionsPanel";
import type { CaseIqAuthenticationStatus, CaseIqMcpPermissionStatus } from "@/lib/caseiq-options";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[], routerRefresh: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: <T>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T | ((current: T) => T)) => {
      hooks.states[index] = typeof next === "function" ? (next as (current: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useRef: (current: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = { current };
    return hooks.states[index];
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: hooks.routerRefresh }) }));

const sessionId = "00000000-0000-4000-8000-000000000001";
const tools: CaseIqMcpPermissionStatus = {
  sessionId, available: true, blockedReason: null, servers: [{
    serverName: "SupportIQ", autoApprove: false, tools: [{ name: "case_get", approved: false, managed: false }],
  }],
};
const ready: CaseIqAuthenticationStatus = { available: true, blockedReason: null, authenticationVerified: false, operation: null };
const fetchMock = vi.fn<typeof fetch>();
let windowTarget: EventTarget;
let cleanups: (() => void)[] = [];

function ToolsHarness(runId = "run") {
  return useCaseIqToolPermissions("work", runId, true);
}
function AuthHarness(runId = "run", automatic = false) {
  return useCaseIqAuthentication("work", runId, true, automatic);
}
function renderTools(runId = "run") {
  hooks.cursor = 0; hooks.effects = [];
  return ToolsHarness(runId);
}
function renderAuth(runId = "run", automatic = false) {
  hooks.cursor = 0; hooks.effects = [];
  return AuthHarness(runId, automatic);
}
const flush = () => vi.advanceTimersByTimeAsync(0);
async function mount<T>(render: () => T) {
  const control = render();
  for (const effect of hooks.effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  await flush();
  return control;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  hooks.states = []; hooks.cursor = 0; hooks.effects = [];
  windowTarget = new EventTarget();
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = []; vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("CaseIQ approval request ordering and feedback", () => {
  it("shows initial loading and coalesces repeated manual refresh clicks", async () => {
    const initial = deferred<Response>();
    fetchMock.mockReturnValueOnce(initial.promise);
    await mount(renderTools);
    expect(renderTools().loading).toBe(true);
    initial.resolve(Response.json(tools)); await flush();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const control = renderTools();
    const first = control.refreshManually();
    await control.refreshManually();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(renderTools().checking).toBe(true);
    pending.resolve(Response.json(tools)); await first;
    expect(renderTools()).toMatchObject({ loading: false, checking: false, error: null, checkedAt: expect.any(String) });
  });

  describe("visible Work automatic SupportIQ sign-in", () => {
    const requestId = "00000000-0000-4000-8000-000000000005";
    const requirement = {
      ...ready, connection: { status: "needs-auth" as const, toolCount: null, checkedAt: new Date().toISOString() },
      automaticSignIn: { requestId, requiredAt: new Date().toISOString(), attempted: false },
    };
    const automatic = () => renderAuth("run", true);
    async function activate() {
      automatic();
      const effect = hooks.effects.at(-1);
      if (!effect) throw new Error("Missing automatic sign-in effect.");
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
      await flush();
    }
    function accepted() {
      return Response.json({ ...requirement, available: false, automaticSignIn: { ...requirement.automaticSignIn, attempted: true },
        operation: { id: requestId, sessionId, sourceRunId: "run", startedAt: new Date().toISOString(),
          status: "opening", reserved: true, message: "Preparing original Session.", trustWorkFolder: true, automatic: true } });
    }
    it("defaults exact-folder trust on, executes the existing action once and preserves its Session", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(requirement));
      await mount(automatic);
      expect(automatic().trustWorkFolder).toBe(true);
      fetchMock.mockResolvedValueOnce(accepted());
      await activate();
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
        runId: "run", requestId, trustWorkFolder: true, automatic: true,
      });
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/mcp auth SupportIQ");
      expect(automatic()).toMatchObject({ reserved: true, uncertain: false });
      await activate();
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    });
    it("does not open for unknown state, inactive Work panels or a hidden page", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(ready));
      await mount(automatic);
      await activate();
      expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
      fetchMock.mockResolvedValueOnce(Response.json(requirement));
      await automatic().refresh();
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      await activate();
      expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      renderAuth("run", false);
      const effect = hooks.effects.at(-1);
      if (!effect) throw new Error("Missing disabled automatic effect.");
      effect();
      await flush();
      expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
    });
    it("waits while Runs/queue are active and opens after a confirmed idle refresh", async () => {
      fetchMock.mockResolvedValueOnce(Response.json({ ...requirement, available: false, blockedReason: "Wait for queued Runs." }));
      await mount(automatic);
      await activate();
      expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
      fetchMock.mockResolvedValueOnce(Response.json(requirement));
      await automatic().refresh();
      fetchMock.mockResolvedValueOnce(accepted());
      await activate();
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    });
    it("still opens the Terminal when automatic clipboard access is denied and surfaces manual typing", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(requirement));
      await mount(automatic);
      vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("Clipboard requires focus."));
      fetchMock.mockResolvedValueOnce(accepted());
      await activate();
      expect(automatic()).toMatchObject({ reserved: true, commandCopied: false, clipboardError: "Clipboard requires focus." });
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    });
    it("can resume automatic opening after a confirmed busy race without retrying an ambiguous dispatch", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(requirement));
      await mount(automatic);
      fetchMock.mockResolvedValueOnce(Response.json({ error: "A Run started first." }, { status: 409 }));
      await activate();
      expect(automatic().uncertain).toBe(false);
      fetchMock.mockResolvedValueOnce(Response.json({ ...requirement, available: false, blockedReason: "Wait for Runs." }));
      await automatic().refresh();
      await activate();
      fetchMock.mockResolvedValueOnce(Response.json(requirement));
      await automatic().refresh();
      fetchMock.mockResolvedValueOnce(accepted());
      await activate();
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
      expect(automatic()).toMatchObject({ reserved: true, error: null });
    });
    it("does not repeat a consumed requirement on remount-like state refreshes or after a window closes", async () => {
      fetchMock.mockResolvedValueOnce(Response.json({ ...requirement,
        automaticSignIn: { ...requirement.automaticSignIn, attempted: true } }));
      await mount(automatic);
      await activate();
      expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
    });
    it("does not repeat an ambiguous dispatch and retains the exact request for reconciliation", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(requirement));
      await mount(automatic);
      fetchMock.mockRejectedValueOnce(new Error("Response was lost."));
      await activate();
      expect(automatic()).toMatchObject({ uncertain: true, reserved: true, error: "Response was lost." });
      await activate();
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    });
    it("respects a user opt-out and retains it when only the Run in this Work changes", async () => {
      fetchMock.mockResolvedValueOnce(Response.json(ready));
      await mount(automatic);
      automatic().setTrustWorkFolder(false);
      expect(automatic().trustWorkFolder).toBe(false);
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      fetchMock.mockResolvedValueOnce(Response.json(ready));
      await mount(() => renderAuth("next-run", true));
      expect(renderAuth("next-run", true).trustWorkFolder).toBe(false);
    });
  });
  it.each([false, true])("never lets an older read overwrite saved approval or surface its stale error (error=%s)", async (failed) => {
    fetchMock.mockResolvedValueOnce(Response.json(tools));
    await mount(renderTools);
    const older = deferred<Response>();
    fetchMock.mockReturnValueOnce(older.promise);
    windowTarget.dispatchEvent(new Event("focus"));
    const approved = { ...tools, servers: [{ ...tools.servers[0], tools: [{ name: "case_get", approved: true, managed: false }] }] };
    fetchMock.mockResolvedValueOnce(Response.json(approved));
    await renderTools().decide("SupportIQ", "case_get", true);
    older.resolve(failed ? Response.json({ error: "Old unavailable response." }, { status: 503 }) : Response.json(tools));
    await flush();
    expect(renderTools()).toMatchObject({ status: approved, error: null, busy: null, notice: expect.stringContaining("not replayed") });
  });
  it("preserves uncertain save errors through background polling until the user explicitly refreshes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(tools));
    await mount(renderTools);
    fetchMock.mockRejectedValueOnce(new Error("Connection interrupted."));
    await renderTools().decide("SupportIQ", "case_get", true);
    fetchMock.mockResolvedValueOnce(Response.json(tools));
    windowTarget.dispatchEvent(new Event("focus")); await flush();
    expect(renderTools().error).toContain("Refresh tool approvals before retrying");
    const before = fetchMock.mock.calls.length;
    await renderTools().decide("SupportIQ", "case_get", true);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    fetchMock.mockResolvedValueOnce(Response.json(tools));
    await renderTools().refreshManually();
    expect(renderTools().error).toBeNull();
  });
  it("turns invalid current metadata into a concise error and retries without claiming a completed check", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(tools));
    await mount(renderTools);
    fetchMock.mockResolvedValueOnce(Response.json({ tools: "invalid" }));
    await renderTools().refreshManually();
    expect(renderTools().error).toBe("CaseIQ returned an invalid tool approval state. Refresh before deciding.");
    expect(renderTools().checkedAt).toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json(tools));
    await renderTools().refreshManually();
    expect(renderTools().error).toBeNull();
  });
  it("does not apply reads from an unmounted scope", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await mount(renderTools);
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    pending.resolve(Response.json(tools)); await flush();
    expect(renderTools().status).toBeNull();
  });
  it("sends the visible pending-tool snapshot only, excluding existing and managed approvals", async () => {
    const requested = [
      { name: "case_get", approved: true, managed: false },
      { name: "get_case_emails", approved: false, managed: false },
      { name: "get_case_notes", approved: false, managed: true },
    ];
    const current = { ...tools, servers: [{ ...tools.servers[0], tools: requested }] };
    fetchMock.mockResolvedValueOnce(Response.json(current));
    await mount(renderTools);
    fetchMock.mockResolvedValueOnce(Response.json({ ...current, servers: [{ ...current.servers[0], tools: requested.map((tool) =>
      tool.name === "get_case_emails" ? { ...tool, approved: true } : tool) }] }));
    await renderTools().approveRequested("SupportIQ");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      runId: "run", serverName: "SupportIQ", action: "approve-requested", toolNames: ["get_case_emails"],
    });
    expect(renderTools().notice).toContain("New tools still need approval");
    expect(renderTools().status?.servers[0].autoApprove).toBe(false);
  });
  it("preserves an accepted automatic-mode choice when an older exact-tool poll completes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(tools));
    await mount(renderTools);
    const older = deferred<Response>();
    fetchMock.mockReturnValueOnce(older.promise);
    windowTarget.dispatchEvent(new Event("focus"));
    fetchMock.mockResolvedValueOnce(Response.json({ ...tools, servers: [{ ...tools.servers[0], autoApprove: true }] }));
    await renderTools().setAutomatic("SupportIQ", true);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ runId: "run", serverName: "SupportIQ", action: "set-automatic", enabled: true });
    older.resolve(Response.json(tools)); await flush();
    expect(renderTools().status?.servers[0].autoApprove).toBe(true);
    expect(renderTools().notice).toContain("including future tools");
  });
  it("keeps decisions on tools with the same name isolated to the selected MCP", async () => {
    const current = { ...tools, servers: [
      ...tools.servers, { serverName: "safewright", autoApprove: false, tools: [{ name: "case_get", approved: false, managed: false }] },
    ] };
    fetchMock.mockResolvedValueOnce(Response.json(current));
    await mount(renderTools);
    fetchMock.mockResolvedValueOnce(Response.json({ ...current, servers: [
      current.servers[0], { ...current.servers[1], tools: [{ name: "case_get", approved: true, managed: false }] },
    ] }));
    await renderTools().decide("safewright", "case_get", true);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      runId: "run", serverName: "safewright", toolName: "case_get", approved: true,
    });
    expect(renderTools().status?.servers[0].tools[0].approved).toBe(false);
    expect(renderTools().notice).toContain("safewright(case_get)");
  });
});

describe("CaseIQ sign-in request ordering", () => {
  it("does not let a previous poll erase an accepted authentication reservation", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(ready));
    await mount(renderAuth);
    const older = deferred<Response>();
    fetchMock.mockReturnValueOnce(older.promise);
    windowTarget.dispatchEvent(new Event("focus"));
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({ ...ready, available: false, operation: {
        id: request.requestId, sessionId, sourceRunId: "run", startedAt: new Date().toISOString(),
        status: "opening", reserved: true, message: "Opening the original native session.",
      } });
    });
    await renderAuth().start();
    older.resolve(Response.json(ready)); await flush();
    expect(renderAuth()).toMatchObject({ reserved: true, uncertain: false, opening: false });
    expect(renderAuth().status?.operation?.reserved).toBe(true);
    expect(hooks.routerRefresh).not.toHaveBeenCalled();
  });
  it("coalesces repeated sign-in refresh clicks and leaves failure visibly unconfirmed", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(ready));
    await mount(renderAuth);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const control = renderAuth();
    const first = control.refreshManually();
    await control.refreshManually();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending.resolve(Response.json({ error: "Native state unavailable." }, { status: 503 }));
    await first;
    expect(renderAuth()).toMatchObject({ checking: false, checkedAt: null, error: "Native state unavailable." });
    await expect(renderAuth().start()).rejects.toThrow("Refresh");
  });

  it("stops active CaseIQ Runs and opens SupportIQ sign-in immediately or once settlement completes", async () => {
    const busyStatus: CaseIqAuthenticationStatus = {
      available: false,
      blockedReason: "Wait for this Work's Runs and queued messages to finish before signing in.",
      canStopRunsToSignIn: true,
      blockingRunCount: 1,
      authenticationVerified: false,
      operation: null,
    };
    fetchMock.mockResolvedValueOnce(Response.json(busyStatus));
    await mount(renderAuth);

    // Deferred settlement path (returns stoppingRuns: true, then opens once idle)
    fetchMock.mockResolvedValueOnce(Response.json({ ...busyStatus, stoppingRuns: true }, { status: 202 }));
    await renderAuth().stopAndStart();
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      action: "stop-and-sign-in",
      runId: "run",
      trustWorkFolder: true,
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/mcp auth SupportIQ");
    expect(renderAuth()).toMatchObject({ stoppingRuns: true, reserved: true });
    expect(hooks.routerRefresh).toHaveBeenCalledOnce();

    // Next refresh reports Work idle -> deferred idle effect opens the sign-in window
    fetchMock.mockResolvedValueOnce(Response.json(ready));
    await renderAuth().refresh();
    renderAuth();
    const idleEffect = hooks.effects.at(-1);
    if (!idleEffect) throw new Error("Missing idle sign-in effect.");
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        ...ready,
        available: false,
        operation: {
          id: request.requestId,
          sessionId,
          sourceRunId: "run",
          startedAt: new Date().toISOString(),
          status: "opening",
          reserved: true,
          message: "Opening the original native session.",
        },
      });
    });
    idleEffect();
    await flush();
    expect(renderAuth()).toMatchObject({ stoppingRuns: false, reserved: true });
    expect(renderAuth().status?.operation?.reserved).toBe(true);
  });
});
