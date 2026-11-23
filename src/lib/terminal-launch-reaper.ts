import { hostname } from "node:os";
import { prisma } from "@/lib/prisma";
import { getTerminalSessionActivity, reconcileTerminalRun } from "@/lib/terminal-resume";
import { TERMINAL_RUN_TRIGGERS } from "@/lib/terminal-run";

interface SyncCandidate {
  id: string;
}

export interface TerminalHistorySyncDependencies<Run extends SyncCandidate = SyncCandidate> {
  listRuns: () => Promise<Run[]>;
  reconcile: (runId: string) => Promise<void>;
  onError: (runId: string, error: unknown) => void;
  shouldReconcile?: (run: Run) => Promise<boolean>;
}

export async function reconcileTerminalRuns(
  services: TerminalHistorySyncDependencies = dependencies,
): Promise<void> {
  await scanTerminalRuns(services);
}

async function scanTerminalRuns<Run extends SyncCandidate>(services: TerminalHistorySyncDependencies<Run>): Promise<void> {
  for (const run of await services.listRuns()) {
    try {
      if (!services.shouldReconcile || await services.shouldReconcile(run)) await services.reconcile(run.id);
    } catch (error) {
      services.onError(run.id, error);
    }
  }
}

const localTerminalRuns = () => ({
  trigger: { in: [...TERMINAL_RUN_TRIGGERS] },
  copilotSessionId: { not: null },
  terminalLaunches: { some: {} },
  resumedRuns: { none: {} },
  OR: [{ hostname: hostname() }, { hostname: null }],
});

const dependencies: TerminalHistorySyncDependencies = {
  listRuns: () => prisma.run.findMany({
    where: {
      ...localTerminalRuns(),
      status: { in: ["RUNNING", "UNKNOWN"] },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  }),
  reconcile: reconcileTerminalRun,
  onError: (runId, error) => console.error(`[terminal-history] Run ${runId}:`, error),
};

interface StopCandidate extends SyncCandidate {
  copilotSessionId: string | null;
  createdAt: Date;
  terminalLaunches: { id: string; inactiveSince: Date | null }[];
}

const stoppedDependencies: TerminalHistorySyncDependencies<StopCandidate> = {
  listRuns: () => prisma.run.findMany({
    where: { ...localTerminalRuns(), status: "RUNNING" },
    select: {
      id: true, copilotSessionId: true, createdAt: true,
      terminalLaunches: { select: { id: true, inactiveSince: true }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  }),
  async shouldReconcile(run) {
    const launch = run.terminalLaunches[0];
    if (!run.copilotSessionId || !launch) throw new Error("Missing Terminal session or launch metadata.");
    const activity = await getTerminalSessionActivity(run.copilotSessionId, launch.id, run.createdAt);
    // Reconcile returning writers to clear an earlier stopped observation.
    return launch.inactiveSince !== null || (!activity.active && !activity.starting);
  },
  reconcile: (runId) => reconcileTerminalRun(runId, new Date(), { stoppedOnly: true }),
  onError: dependencies.onError,
};

const state = globalThis as unknown as {
  terminalHistoryTimer?: NodeJS.Timeout;
  terminalHistoryPending?: Promise<void>;
};

export function startTerminalHistorySync(): void {
  if (state.terminalHistoryTimer) return;
  const checkpointInterval = 60_000;
  let nextCheckpoint = Date.now() + checkpointInterval;
  const tick = () => {
    if (state.terminalHistoryPending) return;
    const now = Date.now();
    const checkpoint = now >= nextCheckpoint;
    if (checkpoint) nextCheckpoint = now + checkpointInterval;
    const pending = (checkpoint ? reconcileTerminalRuns() : scanTerminalRuns(stoppedDependencies))
      .catch((error) => console.error("[terminal-history] Scan failed:", error))
      .finally(() => {
        if (state.terminalHistoryPending === pending) delete state.terminalHistoryPending;
      });
    state.terminalHistoryPending = pending;
  };
  state.terminalHistoryTimer = setInterval(tick, 2_000);
  state.terminalHistoryTimer.unref();
}
