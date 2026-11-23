import type { DirectorySnapshotProgress } from "@/lib/directory-snapshot";
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
  preparation?: WorkRunPreparation;
}

export type WorkRunPreparation =
  | { phase: "files" | "resume" | "startup" }
  | { phase: "snapshot"; progress?: DirectorySnapshotProgress };

export function pendingRunTitle(preparation?: WorkRunPreparation): string {
  switch (preparation?.phase) {
    case "files": return "Preparing Run files";
    case "resume": return "Preparing to resume the session";
    case "snapshot": return preparation.progress ? "Scanning workspace files" : "Creating workspace snapshot";
    case "startup": return "Finishing startup preparation";
    default: return "Waiting to start";
  }
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
    "observationError" in value && (value.observationError === null || typeof value.observationError === "string") &&
    (!("preparation" in value) || value.status === "PENDING" && value.displayStatus === "PENDING" && isPreparation(value.preparation));
}

function isPreparation(value: unknown): value is WorkRunPreparation {
  if (value === null || typeof value !== "object" || !("phase" in value)) return false;
  if (value.phase === "files" || value.phase === "resume" || value.phase === "startup") return !("progress" in value);
  if (value.phase !== "snapshot") return false;
  if (!("progress" in value)) return true;
  const progress = value.progress;
  return progress !== null && typeof progress === "object" &&
    "filesScanned" in progress && typeof progress.filesScanned === "number" &&
    Number.isSafeInteger(progress.filesScanned) && progress.filesScanned >= 0 &&
    "bytesRead" in progress && typeof progress.bytesRead === "number" &&
    Number.isSafeInteger(progress.bytesRead) && progress.bytesRead >= 0;
}