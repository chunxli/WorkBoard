import { isTerminalRunTrigger } from "@/lib/terminal-run";

export const TERMINAL_COMPLETION_UNCONFIRMED =
  "Completion is unconfirmed: this Run has no reported exit status or complete response.";

export const TERMINAL_SYNCING_MESSAGE =
  "Terminal stopped. Synchronizing session history.";

export interface TerminalActivity {
  active: boolean;
  starting: boolean;
}

export interface RunStatusSnapshot {
  id: string;
  status: string;
  displayStatus: string;
  terminalActive: boolean | null;
  observationError: string | null;
}

export function getRunStatusMessage(status: string, message: string | null): string | null {
  if (status === "UNKNOWN" && message?.startsWith("Terminal closed before reporting its exit status")) {
    return TERMINAL_COMPLETION_UNCONFIRMED;
  }
  return message;
}

export function getRunStatusLabel(status: string): string {
  if (status === "IN_TERMINAL") return "IN TERMINAL";
  if (status === "UNKNOWN") return "TERMINAL";
  return status;
}

export function canCancelRun(run: { status: string; trigger: string }): boolean {
  return !isTerminalRunTrigger(run.trigger) && (run.status === "PENDING" || run.status === "RUNNING");
}

export function getWorkRunDisplayStatus(run: {
  status: string;
  trigger: string;
} | null, activity?: TerminalActivity | null): string | null {
  if (!run) return null;
  if (
    isTerminalRunTrigger(run.trigger) &&
    (run.status === "PENDING" || run.status === "RUNNING")
  ) {
    return activity && !activity.active && !activity.starting ? "SYNCING" : "IN_TERMINAL";
  }
  return run.status;
}

export function getRunStatusRevision(snapshot: RunStatusSnapshot): string {
  return JSON.stringify([
    snapshot.id, snapshot.status, snapshot.displayStatus,
    snapshot.terminalActive, snapshot.observationError,
  ]);
}

export function isRunStatusSnapshot(value: unknown): value is RunStatusSnapshot {
  return value !== null && typeof value === "object" &&
    "id" in value && typeof value.id === "string" &&
    "status" in value && typeof value.status === "string" &&
    "displayStatus" in value && typeof value.displayStatus === "string" &&
    "terminalActive" in value && (value.terminalActive === null || typeof value.terminalActive === "boolean") &&
    "observationError" in value && (value.observationError === null || typeof value.observationError === "string");
}