import { hostname } from "node:os";
import { prisma } from "@/lib/prisma";
import { reconcileTerminalRun } from "@/lib/terminal-resume";
import { TERMINAL_RUN_TRIGGERS } from "@/lib/terminal-run";

export interface TerminalHistorySyncDependencies {
  listRuns: () => Promise<{ id: string }[]>;
  reconcile: (runId: string) => Promise<void>;
  onError: (runId: string, error: unknown) => void;
}

export async function reconcileTerminalRuns(
  services: TerminalHistorySyncDependencies = dependencies
): Promise<void> {
  for (const run of await services.listRuns()) {
    try {
      await services.reconcile(run.id);
    } catch (error) {
      services.onError(run.id, error);
    }
  }
}

const dependencies: TerminalHistorySyncDependencies = {
  listRuns: () => prisma.run.findMany({
    where: {
      trigger: { in: [...TERMINAL_RUN_TRIGGERS] },
      status: { in: ["RUNNING", "UNKNOWN"] },
      copilotSessionId: { not: null },
      terminalLaunches: { some: {} },
      resumedRuns: { none: {} },
      OR: [{ hostname: hostname() }, { hostname: null }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  }),
  reconcile: reconcileTerminalRun,
  onError: (runId, error) => console.error(`[terminal-history] Run ${runId}:`, error),
};

const state = globalThis as unknown as {
  terminalHistoryTimer?: NodeJS.Timeout;
  terminalHistoryPending?: Promise<void>;
};

export function startTerminalHistorySync(): void {
  if (state.terminalHistoryTimer) return;
  const tick = () => {
    if (state.terminalHistoryPending) return;
    const pending = reconcileTerminalRuns()
      .catch((error) => console.error("[terminal-history] Scan failed:", error))
      .finally(() => {
        if (state.terminalHistoryPending === pending) delete state.terminalHistoryPending;
      });
    state.terminalHistoryPending = pending;
  };
  state.terminalHistoryTimer = setInterval(tick, 60_000);
  state.terminalHistoryTimer.unref();
}
