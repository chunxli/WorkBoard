import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  values: [] as unknown[],
  refs: [] as { current: unknown }[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.values.push(initial) - 1;
    return [initial, (value: unknown) => { hooks.values[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const ref = { current: initial };
    hooks.refs.push(ref);
    return ref;
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));

import CaseIqStartupStatus from "./CaseIqStartupStatus";

const fetchStatus = vi.fn<typeof fetch>();
const at = "2026-11-10T00:00:00.000Z";
const snapshot = {
  runId: "poll-run", status: "RUNNING", startedAt: at, unavailableReason: null,
  startup: { phase: "launcher", attempt: 1, startedAt: at, updatedAt: at, steps: [{ phase: "checking", at }] },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
let cleanup: (() => void) | void;

beforeEach(() => {
  hooks.effects = []; hooks.values = []; hooks.refs = [];
  cleanup = undefined;
  fetchStatus.mockReset().mockResolvedValue(json(snapshot));
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  vi.stubGlobal("fetch", fetchStatus);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
});
afterEach(async () => {
  cleanup?.();
  await vi.advanceTimersByTimeAsync(1);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount() {
  CaseIqStartupStatus({ runId: "poll-run" });
  cleanup = hooks.effects[0]();
}
async function settle() { await vi.advanceTimersByTimeAsync(1); }
function retry() {
  const action = hooks.refs[0].current;
  if (typeof action !== "function") throw new Error("Missing startup retry action.");
  action();
}

describe("owned current-Run startup polling", () => {
  it("forwards visible tool evidence to feedback without replacing owned Run polling", () => {
    const element = CaseIqStartupStatus({ runId: "poll-run", toolActivityAt: [at] });
    expect(element.props.toolActivityAt).toEqual([at]);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("hydrates a real snapshot with a no-store GET and updates measured time", async () => {
    mount(); await settle();
    expect(fetchStatus).toHaveBeenCalledWith("/api/runs/poll-run?view=startup",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(hooks.values[0]).toEqual(snapshot);
    expect(hooks.values[1]).toBeNull();
    expect(hooks.values[2]).toBeGreaterThanOrEqual(Date.parse(at));
  });

  it("surfaces an HTTP failure and recovers on an explicit metadata-only retry", async () => {
    fetchStatus.mockResolvedValueOnce(json({ error: "Synthetic observation failure" }, 503));
    mount(); await settle();
    expect(hooks.values[0]).toBeNull();
    expect(hooks.values[1]).toContain("HTTP 503");
    retry(); await settle();
    expect(hooks.values[0]).toEqual(snapshot);
    expect(hooks.values[1]).toBeNull();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("rejects a valid snapshot for another Run rather than accepting its processing state", async () => {
    fetchStatus.mockResolvedValueOnce(json({
      ...snapshot, runId: "different-run", startup: { ...snapshot.startup, phase: "processing" },
    }));
    mount(); await settle();
    expect(hooks.values[0]).toBeNull();
    expect(hooks.values[1]).toContain("different Run");
  });

  it("reports a ten-second timeout without overlapping requests or inventing a phase", async () => {
    fetchStatus.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) throw new Error("A bounded startup request must have a cancellation signal.");
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    mount();
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(hooks.values[1]).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.values[0]).toBeNull();
    expect(hooks.values[1]).toContain("timed out");
  });

  it("ignores an old response even if its transport completes after unmount", async () => {
    let release: ((response: Response) => void) | undefined;
    fetchStatus.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    mount();
    cleanup?.(); cleanup = undefined;
    if (!release) throw new Error("The startup request was not started.");
    release(json(snapshot));
    await settle();
    expect(hooks.values).toEqual([null, null, 0]);
  });

  it("stops polling on terminal status and does not infer a stopped native process", async () => {
    fetchStatus.mockResolvedValueOnce(json({ ...snapshot, status: "CANCELLED", startup: null }));
    mount(); await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(hooks.values[0]).toMatchObject({ status: "CANCELLED", startup: null });
  });
});
