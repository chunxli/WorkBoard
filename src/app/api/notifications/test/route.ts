import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { sendSystemNotification } from "@/lib/system-notifier";

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    await sendSystemNotification({
      title: "Work Board notifications are ready",
      message: "This test was sent by the Work Board background process.",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "System notification failed" },
      { status: 500 }
    );
  }
}
