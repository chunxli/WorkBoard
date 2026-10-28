import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  effect: undefined as (() => void | (() => void)) | undefined,
  now: null as number | null,
  setNow: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; },
  useState: () => [hooks.now, hooks.setNow],
}));
import RunDuration from "./RunDuration";

const start = "2026-10-27T11:00:00.000Z";
const props: ComponentProps<typeof RunDuration> = { startedAt: start, finishedAt: null, status: "RUNNING", initialLabel: "11s" };
let documentTarget: EventTarget & { hidden: boolean };
let windowTarget: EventTarget;
let cleanup: (() => void) | void;
const render = (value = props) => renderToStaticMarkup(<RunDuration {...value} />);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T11:00:11.000Z"));
  hooks.now = null;
  hooks.effect = undefined;
  hooks.setNow.mockImplementation((now: number) => { hooks.now = now; });
  documentTarget = Object.assign(new EventTarget(), { hidden: false });
  windowTarget = new EventTarget();
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", windowTarget);
  cleanup = undefined;
});
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live Run elapsed time", () => {
  it("uses the server label initially and ticks without fetching or refreshing the route", async () => {
    vi.setSystemTime(new Date("2026-10-27T11:00:20.000Z"));
    expect(render()).toContain(">11s</span>");
    cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(render()).toContain(">20s</span>");
    await vi.advanceTimersByTimeAsync(3000);
    expect(render()).toContain(">23s</span>");
    expect(hooks.setNow).toHaveBeenLastCalledWith(Date.now());
  });

  it("crosses minute and hour boundaries using actual wall-clock elapsed time", async () => {
    vi.setSystemTime(new Date("2026-10-27T11:00:59.000Z"));
    render(); cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(render()).toContain(">1m 0s</span>");
    vi.setSystemTime(new Date("2026-10-27T11:59:59.000Z"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(render()).toContain(">59m 59s</span>");
    await vi.advanceTimersByTimeAsync(1000);
    expect(render()).toContain(">1h 0m</span>");
  });

  it("skips hidden updates and catches up immediately on returning or focusing", async () => {
    documentTarget.hidden = true;
    render(); cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hooks.setNow).not.toHaveBeenCalled();
    documentTarget.hidden = false;
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(render()).toContain(">21s</span>");
    vi.setSystemTime(new Date("2026-10-27T11:02:00.000Z"));
    windowTarget.dispatchEvent(new Event("focus"));
    expect(render()).toContain(">2m 0s</span>");
  });

  it("stops ticking on completion and uses the frozen server duration", async () => {
    render(); cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(2000);
    cleanup?.();
    hooks.setNow.mockClear();
    const completed = { ...props, status: "SUCCESS", finishedAt: "2026-10-27T11:00:12.000Z", initialLabel: "12s" };
    expect(render(completed)).toContain(">12s</span>");
    cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hooks.setNow).not.toHaveBeenCalled();
    expect(render(completed)).toContain(">12s</span>");
  });

  it.each(["PENDING", "FAILED", "CANCELLED", "TIMED_OUT", "SUCCESS"])("does not tick for %s", async (status) => {
    render({ ...props, status }); cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(3000);
    expect(hooks.setNow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not tick before a start timestamp is available and cleans up on unmount", async () => {
    render({ ...props, startedAt: null, initialLabel: "-" }); cleanup = hooks.effect?.();
    expect(vi.getTimerCount()).toBe(0);
    render(); cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(0);
    cleanup?.();
    cleanup = undefined;
    hooks.setNow.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(hooks.setNow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
