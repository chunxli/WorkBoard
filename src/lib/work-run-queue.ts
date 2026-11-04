export const QUEUED_FOLLOW_UP_MODE = "FOLLOW_UP_QUEUED";

export function getWorkRunQueueKey(run: { id: string; trigger?: string; copilotSessionId: string | null }): string {
  return run.copilotSessionId ? `session:${run.copilotSessionId}` : run.id;
}

export function getWorkQueueBlockedReason(
  activeRuns: readonly {
    trigger: string;
    copilotSessionId: string | null;
    hostname: string | null;
    experimentVariantId?: string | null;
  }[],
  sessionId: string | null,
  currentHostname: string,
): string | null {
  if (!activeRuns.length) return "Wait for a managed Work Run to start before adding to its queue.";
  if (!sessionId) return "Wait for this Run to prepare its session.";
  if (activeRuns.some((run) => run.hostname && run.hostname !== currentHostname)) return "This Work has an active Run on another machine.";
  if (activeRuns.some((run) => run.experimentVariantId || !["WORK", "FOLLOW_UP"].includes(run.trigger))) {
    return "Only managed Work Runs accept queued messages. External Terminal sessions and experiments are read-only.";
  }
  if (activeRuns.some((run) => run.copilotSessionId !== sessionId)) return "Wait for the other Work session to finish.";
  return null;
}

export function orderPendingWorkRuns<T extends { id: string; createdAt: Date; resumedFromRunId: string | null }>(
  runs: readonly T[],
): T[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const visited = new Set<string>();
  const ordered: T[] = [];
  for (const run of [...runs].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())) {
    const chain: T[] = [];
    const walking = new Set<string>();
    let current: T | undefined = run;
    while (current && !visited.has(current.id)) {
      if (walking.has(current.id)) throw new Error(`Cyclic queued follow-up dependency at Run ${current.id}`);
      walking.add(current.id);
      chain.push(current);
      current = current.resumedFromRunId ? byId.get(current.resumedFromRunId) : undefined;
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      visited.add(chain[index].id);
      ordered.push(chain[index]);
    }
  }
  return ordered;
}
