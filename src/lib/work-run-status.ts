import { isTerminalRunTrigger } from "@/lib/terminal-run";

export function getRunStatusLabel(status: string): string {
  if (status === "IN_TERMINAL") return "IN TERMINAL";
  if (status === "UNKNOWN") return "TERMINAL / STATUS UNKNOWN";
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