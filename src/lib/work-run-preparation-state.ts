import { hostname } from "node:os";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import type { WorkRunPreparation } from "@/lib/work-run-status";

const state = globalThis as typeof globalThis & {
  workRunPreparations?: Map<string, { current: WorkRunPreparation }>;
};
const preparations = state.workRunPreparations ??= new Map();

export function beginWorkRunPreparation(runId: string) {
  const observation: { current: WorkRunPreparation } = { current: { phase: "files" } };
  preparations.set(runId, observation);
  return {
    report(current: WorkRunPreparation) {
      observation.current = current;
    },
    finish() {
      if (preparations.get(runId) === observation) preparations.delete(runId);
    },
  };
}

export function getPendingRunPreparation(run: { id: string; status: string; trigger: string; hostname: string | null }) {
  if (run.status !== "PENDING" || isTerminalRunTrigger(run.trigger) || run.hostname && run.hostname !== hostname()) return undefined;
  return preparations.get(run.id)?.current;
}
