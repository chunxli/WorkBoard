import path from "node:path";
import { rm } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import {
  finalizeFailedTerminalRun,
  syncExpiredTerminalRun,
  tryReadTerminalLaunchExitCode,
} from "@/lib/terminal-resume";

const TERMINAL_EXPIRY_ERROR = "Terminal callback token expired";
const TERMINAL_REAPER_INTERVAL_MS = 60_000;
const STALE_SYNCING_MS = 5 * 60_000;

export interface ExpiredTerminalLaunch {
  id: string;
  runId: string;
  updatedAt: Date;
}

export interface TerminalLaunchReaperDependencies {
  now: () => Date;
  listExpired: (now: Date) => Promise<ExpiredTerminalLaunch[]>;
  claimExpired: (
    launch: ExpiredTerminalLaunch,
    now: Date,
    errorMessage: string
  ) => Promise<boolean>;
  finalizeRun: (runId: string, errorMessage: string, finishedAt: Date) => Promise<boolean>;
  readExitCode: (launchId: string) => Promise<number | null>;
  syncExpiredRun: (runId: string, exitCode: number) => Promise<unknown>;
  removeLaunchFile: (launchId: string) => Promise<void>;
}

export async function reapExpiredTerminalRuns(
  dependencies: TerminalLaunchReaperDependencies = prismaTerminalLaunchReaperDependencies
): Promise<number> {
  const now = dependencies.now();
  const candidates = await dependencies.listExpired(now);
  let reaped = 0;
  for (const launch of candidates) {
    const exitCode = await dependencies.readExitCode(launch.id);
    if (exitCode !== null) {
      await dependencies.syncExpiredRun(launch.runId, exitCode);
      await dependencies.removeLaunchFile(launch.id).catch(() => {});
      reaped += 1;
      continue;
    }
    const claimed = await dependencies.claimExpired(launch, now, TERMINAL_EXPIRY_ERROR);
    if (!claimed) continue;
    try {
      await dependencies.finalizeRun(launch.runId, TERMINAL_EXPIRY_ERROR, now);
    } finally {
      await dependencies.removeLaunchFile(launch.id).catch(() => {});
    }
    reaped += 1;
  }
  return reaped;
}

const prismaTerminalLaunchReaperDependencies: TerminalLaunchReaperDependencies = {
  now: () => new Date(),
  listExpired: (now) => prisma.terminalLaunch.findMany({
    where: {
      run: { status: "RUNNING" },
      expiresAt: { lte: now },
      OR: [
        { status: { in: ["PENDING", "LAUNCHED", "FAILED"] } },
        {
          status: "SYNCING",
          updatedAt: { lte: new Date(now.getTime() - STALE_SYNCING_MS) },
        },
      ],
    },
    select: { id: true, runId: true, updatedAt: true },
  }),
  claimExpired: async (launch, now, errorMessage) => (await prisma.terminalLaunch.updateMany({
    where: {
      id: launch.id,
      updatedAt: launch.updatedAt,
      expiresAt: { lte: now },
      OR: [
        { status: { in: ["PENDING", "LAUNCHED", "FAILED"] } },
        {
          status: "SYNCING",
          updatedAt: { lte: new Date(now.getTime() - STALE_SYNCING_MS) },
        },
      ],
    },
    data: {
      status: "FAILED",
      completedAt: now,
      errorMessage,
    },
  })).count === 1,
  finalizeRun: finalizeFailedTerminalRun,
  readExitCode: tryReadTerminalLaunchExitCode,
  syncExpiredRun: syncExpiredTerminalRun,
  removeLaunchFile: async (launchId) => {
    await rm(
      path.join(process.cwd(), "data", "terminal-launches", `${launchId}.json`),
      { force: true }
    );
  },
};

const globalForTerminalReaper = globalThis as unknown as {
  terminalLaunchReaperTimer?: NodeJS.Timeout;
  terminalLaunchReaperRun?: Promise<number>;
};

export function startTerminalLaunchReaper(): void {
  if (globalForTerminalReaper.terminalLaunchReaperTimer) return;
  const tick = () => {
    if (globalForTerminalReaper.terminalLaunchReaperRun) return;
    const pending = reapExpiredTerminalRuns()
      .catch((error) => {
        console.error("[terminal-reaper] failed:", error);
        return 0;
      })
      .finally(() => {
        if (globalForTerminalReaper.terminalLaunchReaperRun === pending) {
          delete globalForTerminalReaper.terminalLaunchReaperRun;
        }
      });
    globalForTerminalReaper.terminalLaunchReaperRun = pending;
  };
  const timer = setInterval(tick, TERMINAL_REAPER_INTERVAL_MS);
  timer.unref();
  globalForTerminalReaper.terminalLaunchReaperTimer = timer;
}
