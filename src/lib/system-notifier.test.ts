import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notify, windowsNotify } = vi.hoisted(() => ({ notify: vi.fn(), windowsNotify: vi.fn() }));

vi.mock("node-notifier", () => ({
  default: { notify },
}));
vi.mock("@/lib/windows-system-notifier", () => ({ sendWindowsSystemNotification: windowsNotify }));

import { compactNotificationText, resolveNotificationUrl, sendSystemNotification } from "./system-notifier";

const sample = { title: "Ready", message: "Finished", destination: { kind: "settings" as const } };

beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  vi.stubEnv("AUTH_URL", undefined);
  windowsNotify.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  notify.mockReset();
  windowsNotify.mockReset();
});

describe("system notifier adapter", () => {
  it("returns after the submission grace without waiting for toast dismissal", async () => {
    vi.useFakeTimers();
    notify.mockImplementation(() => undefined);

    const submission = sendSystemNotification(sample);
    await vi.advanceTimersByTimeAsync(500);

    await expect(submission).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("reports synchronous notifier startup errors", async () => {
    notify.mockImplementation(() => {
      throw new Error("notifier unavailable");
    });

    await expect(sendSystemNotification(sample)).rejects.toThrow("notifier unavailable");
  });

  it("uses direct Windows protocol activation and never falls back to generic SnoreToast", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await sendSystemNotification({ ...sample, destination: { kind: "work", id: "work-1" }, details: "2m · 12K tokens" });
    expect(windowsNotify).toHaveBeenCalledExactlyOnceWith({
      title: "Ready", message: "Finished", details: "2m · 12K tokens", url: "http://localhost:3100/work/work-1",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports native failure instead of resolving success after the old 500ms grace", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    windowsNotify.mockRejectedValue(new Error("Native registration was denied"));
    await expect(sendSystemNotification(sample)).rejects.toThrow("Native registration was denied");
    expect(notify).not.toHaveBeenCalled();
  });

  it("passes supported macOS links and a local brand icon while retaining existing delivery", async () => {
    notify.mockImplementation((_options, callback) => callback(null));
    await sendSystemNotification(sample);
    expect(notify.mock.calls[0][0]).toMatchObject({
      open: "http://localhost:3100/settings#notifications",
      icon: expect.stringContaining("workboard-notification.png"), wait: false,
    });

  });

  it("preserves Linux delivery without pretending that notify-send supports a click URL", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    notify.mockImplementation((_options, callback) => callback(null));
    await sendSystemNotification({ ...sample, details: "Compact metrics" });
    expect(notify.mock.calls[0][0]).toMatchObject({ title: "Ready", message: "Finished\nCompact metrics", wait: false });
    expect(notify.mock.calls[0][0]).not.toHaveProperty("open");
  });

  it("does not open or send anything for an invalid deployment URL", async () => {
    vi.stubEnv("AUTH_URL", "file:///invalid");
    await expect(sendSystemNotification(sample)).rejects.toThrow("AUTH_URL");
    expect(windowsNotify).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "work", id: "work-1" }, "http://localhost:3100/work/work-1"],
    [{ kind: "run", id: "run-1" }, "http://localhost:3100/runs/run-1"],
    [{ kind: "settings" }, "http://localhost:3100/settings#notifications"],
  ] as const)("maps the internal destination %j without relying on the request host", (destination, expected) => {
    expect(resolveNotificationUrl(destination, {})).toBe(expected);
  });

  it("uses the deployment origin and safely encodes IDs", () => {
    expect(resolveNotificationUrl({ kind: "work", id: 'work/中文&"' }, { AUTH_URL: "https://board.example/" }))
      .toBe("https://board.example/work/work%2F%E4%B8%AD%E6%96%87%26%22");
  });

  it.each(["javascript:alert(1)", "file:///secret", "https://user:secret@example.com", "not-url", "https://example.com?token=secret", "https://example.com/#fragment"])(
    "rejects untrusted base %s without exposing it",
    (base) => {
      expect(() => resolveNotificationUrl(sample.destination, { AUTH_URL: base })).toThrow("AUTH_URL");
    },
  );

  it.each(["", ".", "..", "invalid\nid"])("rejects invalid path ID %j", (id) => {
    expect(() => resolveNotificationUrl({ kind: "work", id }, {})).toThrow("valid Work or Run ID");
  });

  it("bounds content without cutting Unicode graphemes or keeping control lines", () => {
    expect(compactNotificationText(" Name\nwith\tspacing ", 100)).toBe("Name with spacing");
    expect(compactNotificationText("👩‍💻".repeat(6), 4)).toBe("👩‍💻👩‍💻👩‍💻…");
  });
});
