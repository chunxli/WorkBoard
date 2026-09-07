import { afterEach, describe, expect, it, vi } from "vitest";

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock("node-notifier", () => ({
  default: { notify },
}));

import { sendSystemNotification } from "./system-notifier";

afterEach(() => {
  vi.useRealTimers();
  notify.mockReset();
});

describe("system notifier adapter", () => {
  it("returns after the submission grace without waiting for toast dismissal", async () => {
    vi.useFakeTimers();
    notify.mockImplementation(() => undefined);

    const submission = sendSystemNotification({ title: "Ready", message: "Finished" });
    await vi.advanceTimersByTimeAsync(500);

    await expect(submission).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("reports synchronous notifier startup errors", async () => {
    notify.mockImplementation(() => {
      throw new Error("notifier unavailable");
    });

    await expect(
      sendSystemNotification({ title: "Ready", message: "Finished" })
    ).rejects.toThrow("notifier unavailable");
  });
});
