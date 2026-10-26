import notifier from "node-notifier";
import path from "node:path";
import { sendWindowsSystemNotification } from "@/lib/windows-system-notifier";

export interface SystemNotification {
  title: string;
  message: string;
  details?: string;
  destination: { kind: "work" | "run"; id: string } | { kind: "settings" };
}

export type SystemNotifier = (notification: SystemNotification) => Promise<void>;

export function compactNotificationText(value: string, maxCharacters: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const characters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)].map((part) => part.segment);
  return characters.length <= maxCharacters ? clean : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export function resolveNotificationUrl(
  destination: SystemNotification["destination"],
  environment: { AUTH_URL?: string } = { AUTH_URL: process.env.AUTH_URL },
): string {
  let base: URL;
  try {
    base = new URL(environment.AUTH_URL?.trim() || "http://localhost:3100");
  } catch {
    throw new Error("AUTH_URL must be an absolute HTTP(S) URL for notification links.");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("AUTH_URL for notification links must use HTTP(S), without credentials, query or fragment.");
  }
  if (destination.kind === "settings") return new URL("/settings#notifications", base.origin).href;
  if (!destination.id || [".", ".."].includes(destination.id) || /[\u0000-\u001f\u007f]/.test(destination.id)) {
    throw new Error("A notification destination must have a valid Work or Run ID.");
  }
  return new URL(`/${destination.kind === "work" ? "work" : "runs"}/${encodeURIComponent(destination.id)}`, base.origin).href;
}

export const sendSystemNotification: SystemNotifier = async (notification) => {
  const url = resolveNotificationUrl(notification.destination);
  if (process.platform === "win32") {
    await sendWindowsSystemNotification({
      title: compactNotificationText(notification.title, 60),
      message: compactNotificationText(notification.message, 100),
      details: notification.details ? compactNotificationText(notification.details, 100) : undefined,
      url,
    });
    return;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(submissionTimer);
      if (error) reject(error);
      else resolve();
    };
    const submissionTimer = setTimeout(() => finish(), 500);

    try {
      notifier.notify(
        {
          title: notification.title,
          message: [notification.message, notification.details].filter(Boolean).join("\n"),
          icon: path.join(process.cwd(), "public", "workboard-notification.png"),
          ...(process.platform === "darwin" ? { open: url } : {}),
          wait: false,
        },
        (error) => finish(error)
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
};
