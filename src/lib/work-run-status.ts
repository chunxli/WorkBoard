import { isTerminalRunTrigger } from "@/lib/terminal-run";

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