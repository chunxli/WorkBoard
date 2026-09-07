import { describe, expect, it } from "vitest";
import { normalizeSystemNotificationSettings } from "./notification-settings";
import { systemNotificationSettingsSchema } from "./validation";

describe("system notification settings", () => {
  it("defaults to enabled and preserves an explicit disabled preference", () => {
    expect(normalizeSystemNotificationSettings(null)).toEqual({ enabled: true });
    expect(normalizeSystemNotificationSettings({ systemNotificationsEnabled: false }))
      .toEqual({ enabled: false });
  });

  it("accepts only a strict enabled boolean payload", () => {
    expect(systemNotificationSettingsSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(systemNotificationSettingsSchema.safeParse({ enabled: "true" }).success).toBe(false);
    expect(systemNotificationSettingsSchema.safeParse({ enabled: true, extra: true }).success)
      .toBe(false);
  });
});
