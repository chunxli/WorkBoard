import type { CaseIqStartupPhase, CaseIqStartupState } from "@/lib/caseiq-startup";

const globalForStartup = globalThis as typeof globalThis & {
  caseIqStartupStates?: Map<string, CaseIqStartupState>;
};
const states = globalForStartup.caseIqStartupStates ??= new Map<string, CaseIqStartupState>();

export function reportCaseIqStartup(runId: string, phase: CaseIqStartupPhase, attempt: number): void {
  const prior = states.get(runId);
  if (prior?.phase === phase && prior.attempt === attempt) return;
  const at = new Date().toISOString();
  const sameAttempt = prior?.attempt === attempt;
  states.set(runId, {
    phase, attempt, startedAt: sameAttempt ? prior.startedAt : at, updatedAt: at,
    steps: [...(sameAttempt ? prior.steps : []), { phase, at }].slice(-7),
  });
}

export function getCaseIqStartup(runId: string): CaseIqStartupState | null {
  return states.get(runId) ?? null;
}

export function clearCaseIqStartup(runId: string): void {
  states.delete(runId);
}
