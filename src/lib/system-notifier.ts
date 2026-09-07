import notifier from "node-notifier";

export interface SystemNotification {
  title: string;
  message: string;
}

export type SystemNotifier = (notification: SystemNotification) => Promise<void>;

export const sendSystemNotification: SystemNotifier = (notification) =>
  new Promise((resolve, reject) => {
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
          message: notification.message,
          wait: false,
        },
        (error) => finish(error)
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
