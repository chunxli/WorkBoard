import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunStatusSnapshot } from "@/lib/work-run-status";

const harness = vi.hoisted(() => ({
  effect: undefined as (() => void | (() => void)) | undefined,
  refresh: vi.fn(), setError: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { harness.effect = effect; },
  useState: () => [null, harness.setError],
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: harness.refresh }) }));

import RunStatusRefresher from "./RunStatusRefresher";

let documentTarget: EventTarget & { hidden: boolean };
let windowTarget: EventTarget;
let cleanup: void | (() => void);
const initial: RunStatusSnapshot = {
  id: "status-run", status: "RUNNING", displayStatus: "IN_TERMINAL",
  terminalActive: true, observationError: null,
};
const fetchStatus = vi.fn<typeof fetch>();
const respond = (snapshot: unknown, status = 200) => Promise.resolve(Response.json(snapshot, { status }));
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  documentTarget = Object.assign(new EventTarget(), { hidden: false });
  windowTarget = new EventTarget();
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("fetch", fetchStatus);
  cleanup = undefined;
});

afterEach(() => {
  if (typeof cleanup === "function") cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(snapshot = initial) {
  RunStatusRefresher({ initialState: snapshot });
  cleanup = harness.effect?.();
}

describe("Run status observation independent of history and output tabs", () => {
  it("refreshes when the first response already differs from the server-rendered status", async () => {
    fetchStatus.mockImplementation(() => respond({ ...initial, status: "SUCCESS", displayStatus: "SUCCESS", terminalActive: null }));
    mount();
    await flush();
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(fetchStatus).toHaveBeenCalledWith("/api/runs/status-run?view=status", expect.objectContaining({ cache: "no-store" }));
  });

  it("refreshes for activity-only changes and keeps polling SYNCING without a refresh loop", async () => {
    const stopped = { ...initial, displayStatus: "SYNCING", terminalActive: false };
    fetchStatus.mockImplementation(() => respond(stopped));
    mount();
    await flush();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(fetchStatus).toHaveBeenCalledTimes(4);
    if (typeof cleanup === "function") cleanup();
    mount(stopped);
    fetchStatus.mockImplementation(() => respond({ ...stopped, status: "SUCCESS", displayStatus: "SUCCESS", terminalActive: null }));
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(harness.refresh).toHaveBeenCalledTimes(2);
  });

  it("retries failures explicitly without fetching any conversation or log data", async () => {
    fetchStatus.mockImplementationOnce(() => respond({ error: "Temporary status error" }, 503))
      .mockImplementation(() => respond(initial));
    mount();
    await flush();
    expect(harness.setError).toHaveBeenCalledWith("Temporary status error");
    await vi.advanceTimersByTimeAsync(4000);
    expect(harness.setError).toHaveBeenLastCalledWith(null);
    expect(fetchStatus.mock.calls.every(([url]) => url === "/api/runs/status-run?view=status")).toBe(true);
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it("does not overlap interval, focus, and visibility requests", async () => {
    const pending = Promise.withResolvers<Response>();
    fetchStatus.mockReturnValueOnce(pending.promise);
    mount();
    await vi.advanceTimersByTimeAsync(8000);
    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(fetchStatus).toHaveBeenCalledOnce();
    pending.resolve(Response.json(initial));
    await flush();
  });

  it("waits while hidden, resumes on visibility, and aborts/ignores responses after unmount", async () => {
    documentTarget.hidden = true;
    const pending = Promise.withResolvers<Response>();
    fetchStatus.mockReturnValue(pending.promise);
    mount();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchStatus).not.toHaveBeenCalled();
    documentTarget.hidden = false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(fetchStatus).toHaveBeenCalledOnce();
    const signal = fetchStatus.mock.calls[0][1]?.signal;
    if (typeof cleanup === "function") cleanup();
    cleanup = undefined;
    expect(signal?.aborted).toBe(true);
    pending.resolve(Response.json({ ...initial, displayStatus: "SYNCING", terminalActive: false }));
    await flush();
    await vi.advanceTimersByTimeAsync(8000);
    windowTarget.dispatchEvent(new Event("focus"));
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(fetchStatus).toHaveBeenCalledOnce();
  });

  it("rejects invalid metadata and responses for another Run", async () => {
    fetchStatus.mockImplementationOnce(() => respond({ status: "SUCCESS" }))
      .mockImplementationOnce(() => respond({ ...initial, id: "another-run" }));
    mount();
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(harness.setError).toHaveBeenCalledTimes(2);
    expect(harness.setError).toHaveBeenLastCalledWith("Invalid Run status response");
    expect(harness.refresh).not.toHaveBeenCalled();
  });
});
