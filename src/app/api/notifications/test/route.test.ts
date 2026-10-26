import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const { user, send } = vi.hoisted(() => ({ user: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: user }));
vi.mock("@/lib/system-notifier", () => ({ sendSystemNotification: send }));

beforeEach(() => {
  vi.resetAllMocks();
  user.mockResolvedValue("synthetic-user");
  send.mockResolvedValue(undefined);
});

describe("branded notification test", () => {
  it("uses the same native pathway with an internal Settings target", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      title: "Notifications ready", message: "Work Board", details: "Select to open notification settings.",
      destination: { kind: "settings" },
    });
  });

  it("requires an authenticated user and never sends a notification otherwise", async () => {
    user.mockResolvedValue(null);
    expect((await POST()).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces native delivery errors rather than claiming a successful test", async () => {
    send.mockRejectedValue(new Error("Native notification registration denied"));
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Native notification registration denied" });
  });
});
