import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import {
  getSystemNotificationSettings,
  saveSystemNotificationSettings,
} from "@/lib/notification-settings";
import { systemNotificationSettingsSchema } from "@/lib/validation";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await getSystemNotificationSettings(userId));
}

export async function PUT(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = systemNotificationSettingsSchema.safeParse(
    await req.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  return NextResponse.json(
    await saveSystemNotificationSettings(userId, parsed.data.enabled)
  );
}
