import { hostname } from "node:os";
import { authMode } from "@/lib/auth-mode";
import { getTerminalSessionActivity } from "@/lib/terminal-resume";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { getWorkRunDisplayStatus, type RunStatusSnapshot, type TerminalActivity } from "@/lib/work-run-status";

interface ObservableRun {
  id: string;
  status: string;
  trigger: string;
  copilotSessionId: string | null;
  hostname: string | null;
  createdAt: Date;
  terminalLaunches: readonly { id: string; errorMessage?: string | null }[];
  resumedRuns?: readonly { id: string }[];
}

export async function getRunStatusSnapshot(run: ObservableRun): Promise<RunStatusSnapshot> {
  let activity: TerminalActivity | null = null;
  let observationError: string | null = null;
  if (
    isTerminalRunTrigger(run.trigger) && ["PENDING", "RUNNING"].includes(run.status) &&
    !run.resumedRuns?.length
  ) {
    if (run.hostname && run.hostname !== hostname()) {
      observationError = "Terminal activity can only be checked on the machine that owns this Run.";
    } else if (!run.hostname && authMode !== "local") {
      observationError = "The host of this older Run could not be verified. Terminal activity is unavailable.";
    } else if (!run.copilotSessionId) {
      observationError = "Terminal session metadata is unavailable. Its activity could not be verified.";
    } else {
      try {
        activity = await getTerminalSessionActivity(
          run.copilotSessionId, run.terminalLaunches[0]?.id ?? null, run.createdAt,
        );
      } catch (error) {
        console.error(`[run-status] Unable to check Terminal activity for Run ${run.id}:`, error);
        observationError = `Unable to check Terminal activity: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
    }
    const syncError = run.terminalLaunches[0]?.errorMessage;
    if (!observationError && syncError) observationError = `Session synchronization failed: ${syncError}`;
  }
  return {
    id: run.id,
    status: run.status,
    displayStatus: getWorkRunDisplayStatus(run, activity)!,
    terminalActive: activity ? activity.active || activity.starting : null,
    observationError,
  };
}
