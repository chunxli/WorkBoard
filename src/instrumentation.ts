export async function register() {
  // Only start background scheduling in the actual Node server process (not edge/build).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { preventSystemSleep } = await import("@/lib/keep-awake");
    preventSystemSleep();

    const { recoverRuns } = await import("@/lib/run-recovery");
    await recoverRuns();

    const {
      reconcileTerminalRuns,
      startTerminalHistorySync,
    } = await import("@/lib/terminal-launch-reaper");
    await reconcileTerminalRuns();
    startTerminalHistorySync();

    const {
      reconcileMissingWorkDirectories,
      startWorkDirectoryReconciliation,
    } = await import("@/lib/work-directory-reconciler");
    await reconcileMissingWorkDirectories();
    startWorkDirectoryReconciliation();

    const {
      dispatchPendingSystemNotifications,
      startSystemNotificationDispatcher,
    } = await import("@/lib/notification-dispatcher");
    await dispatchPendingSystemNotifications();
    startSystemNotificationDispatcher();

    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
