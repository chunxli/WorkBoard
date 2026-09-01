export async function register() {
  // Only start background scheduling in the actual Node server process (not edge/build).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();

    const { preventSystemSleep } = await import("@/lib/keep-awake");
    preventSystemSleep();

    const { recoverRuns } = await import("@/lib/run-recovery");
    await recoverRuns();
  }
}
