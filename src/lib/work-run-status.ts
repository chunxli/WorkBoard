import { isTerminalRunTrigger } from "@/lib/terminal-run";

export const TERMINAL_COMPLETION_UNCONFIRMED =
  "Completion is unconfirmed: this Run has no reported exit status or complete response.";

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

export function getWorkRunDisplayStatus(run: {
  status: string;
  trigger: string;
} | null): string | null {
  if (!run) return null;
  if (
    isTerminalRunTrigger(run.trigger) &&
    (run.status === "PENDING" || run.status === "RUNNING")
  ) {
    return "IN_TERMINAL";
  }
  return run.status;
}