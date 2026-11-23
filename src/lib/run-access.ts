import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getRepoWorkdirPath } from "@/lib/repo-workdir";
import { canonicalizeWorkPath } from "@/lib/work-files";
import { pathIsWithin } from "@/lib/native-runtime-paths";
import { pairedWorkLane } from "@/lib/work-session-pair";

export function ownedRunWhere(userId: string, runId?: string): Prisma.RunWhereInput {
  return {
    ...(runId ? { id: runId } : {}),
    OR: [{ task: { repo: { userId } } }, { work: { userId } }],
  };
}

export async function findActiveRunConflicts(
  userId: string,
  directoryPath: string,
  includeNested = false,
): Promise<Array<{ id: string }>> {
  const targetPath = canonicalizeWorkPath(directoryPath);
  const runs = await prisma.run.findMany({
    where: { ...ownedRunWhere(userId), status: { in: ["PENDING", "RUNNING"] } },
    select: {
      id: true,
      executionPath: true,
      copilotSessionId: true,
      work: { select: { directoryPath: true, sessionPair: { select: { cliSessionId: true, caseIqSessionId: true } } } },
      task: { select: { repo: true } },
    },
  });
  return runs
    .filter((run) => {
      const activePath =
        run.executionPath ??
        run.work?.directoryPath ??
        (run.task ? getRepoWorkdirPath(run.task.repo) : null);
      if (run.work?.sessionPair && pairedWorkLane(run.work.sessionPair, run.copilotSessionId)) {
        const shared = canonicalizeWorkPath(run.work.directoryPath);
        if (pathIsWithin(shared, targetPath) || pathIsWithin(targetPath, shared)) return true;
      }
      if (!activePath) return false;
      const active = canonicalizeWorkPath(activePath);
      return active === targetPath || includeNested && (pathIsWithin(targetPath, active) || pathIsWithin(active, targetPath));
    })
    .map(({ id }) => ({ id }));
}