export function getWorkRunDisplayStatus(run: {
  status: string;
  trigger: string;
} | null): string | null {
  if (!run) return null;
  if (
    run.trigger === "TERMINAL_RESUME" &&
    (run.status === "PENDING" || run.status === "RUNNING")
  ) {
    return "IN_TERMINAL";
  }
  return run.status;
}