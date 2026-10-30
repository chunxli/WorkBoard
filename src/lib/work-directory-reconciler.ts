import { lstat, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import { getTerminalSessionActivity } from "@/lib/terminal-resume";

async function directoryIsMissing(directoryPath: string): Promise<boolean> {
  if (!path.isAbsolute(directoryPath)) throw new Error("Cannot verify a non-absolute Work directory.");
  try {
    await lstat(directoryPath);
    return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  // An unavailable drive or share must not be mistaken for a deleted Work folder.
  return (await stat(path.parse(directoryPath).root)).isDirectory();
}

export async function reconcileMissingWorkDirectories(userId?: string): Promise<void> {
  const where = {
    ...(userId ? { userId } : {}),
    status: { not: "ARCHIVED" },
    hostname: hostname(),
    runs: { none: { status: { in: ["PENDING", "RUNNING"] } } },
  } satisfies Prisma.WorkWhereInput;
  const works = await prisma.work.findMany({
    where,
    select: {
      id: true, directoryPath: true, updatedAt: true, archivedAt: true,
      runs: {
        where: { copilotSessionId: { not: null } },
        select: { copilotSessionId: true, terminalLaunches: { select: { id: true }, take: 1 } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  for (const work of works) {
    const sessions = new Map<string, string | null>();
    for (const run of work.runs) {
      if (run.copilotSessionId && !sessions.has(run.copilotSessionId)) {
        sessions.set(run.copilotSessionId, run.terminalLaunches[0]?.id ?? null);
      }
    }
    try {
      if (!(await directoryIsMissing(work.directoryPath))) continue;
      await withRunStartLock([`work:${work.id}`, ...[...sessions.keys()].map((id) => `session:${id}`)], async () => {
        for (const [sessionId, launchId] of sessions) {
          const activity = await getTerminalSessionActivity(sessionId, launchId);
          if (activity.active || activity.starting) return;
        }
        if (!(await directoryIsMissing(work.directoryPath))) return;
        // The root is gone: preserve history and never recreate it to write a manifest.
        const result = await prisma.work.updateMany({
          where: { ...where, id: work.id, directoryPath: work.directoryPath, updatedAt: work.updatedAt },
          data: { status: "ARCHIVED", archivedAt: work.archivedAt ?? new Date() },
        });
        if (result.count) console.info(`[work-directory] Archived Work ${work.id}: root directory no longer exists.`);
      });
    } catch (error) {
      if (error instanceof RunStartInProgressError) continue;
      console.error(`[work-directory] Could not verify or archive Work ${work.id}:`, error);
    }
  }
}

const state = globalThis as typeof globalThis & {
  workDirectoryTimer?: NodeJS.Timeout;
  workDirectoryPending?: Promise<void>;
};

export function startWorkDirectoryReconciliation(): void {
  if (state.workDirectoryTimer) return;
  state.workDirectoryTimer = setInterval(() => {
    if (state.workDirectoryPending) return;
    const pending = reconcileMissingWorkDirectories()
      .catch((error) => console.error("[work-directory] Scan failed:", error))
      .finally(() => {
        if (state.workDirectoryPending === pending) delete state.workDirectoryPending;
      });
    state.workDirectoryPending = pending;
  }, 30_000);
  state.workDirectoryTimer.unref();
}
