import { prisma } from "@/lib/prisma";

export interface SystemNotificationSettingsValue {
  enabled: boolean;
}

export function normalizeSystemNotificationSettings(
  stored?: { systemNotificationsEnabled?: boolean | null } | null
): SystemNotificationSettingsValue {
  return { enabled: stored?.systemNotificationsEnabled ?? true };
}

export async function getSystemNotificationSettings(
  userId: string
): Promise<SystemNotificationSettingsValue> {
  const stored = await prisma.userExecutionSettings.findUnique({
    where: { userId },
    select: { systemNotificationsEnabled: true },
  });
  return normalizeSystemNotificationSettings(stored);
}

export async function saveSystemNotificationSettings(
  userId: string,
  enabled: boolean
): Promise<SystemNotificationSettingsValue> {
  const stored = await prisma.userExecutionSettings.upsert({
    where: { userId },
    create: { userId, systemNotificationsEnabled: enabled },
    update: { systemNotificationsEnabled: enabled },
    select: { systemNotificationsEnabled: true },
  });
  return normalizeSystemNotificationSettings(stored);
}
