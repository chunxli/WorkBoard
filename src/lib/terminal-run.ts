export const TERMINAL_RUN_TRIGGERS = ["TERMINAL_START", "TERMINAL_RESUME"] as const;

export function isTerminalRunTrigger(trigger: string): boolean {
  return TERMINAL_RUN_TRIGGERS.includes(
    trigger as typeof TERMINAL_RUN_TRIGGERS[number]
  );
}