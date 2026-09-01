import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getRepoWorkdirPath } from "@/lib/repo-workdir";
import { canonicalizeWorkPath } from "@/lib/work-files";

export function ownedRunWhere(userId: string, runId?: string): Prisma.RunWhereInput {
  return {
    ...(runId ? { id: runId } : {}),
    OR: [{ task: { repo: { userId } } }, { work: { userId } }],
  };
}

export async function findActiveRunConflicts(
  userId: string,
  directoryPath: string
): Promise<Array<{ id: string }>> {
  const targetPath = canonicalizeWorkPath(directoryPath);
  const runs = await prisma.run.findMany({
    where: { ...ownedRunWhere(userId), status: { in: ["PENDING", "RUNNING"] } },
    select: {
      id: true,
      executionPath: true,
      work: { select: { directoryPath: true } },
      task: { select: { repo: true } },
    },
  });
  return runs
    .filter((run) => {
      const activePath =
        run.executionPath ??
        run.work?.directoryPath ??
        (run.task ? getRepoWorkdirPath(run.task.repo) : null);
      return activePath !== null && canonicalizeWorkPath(activePath) === targetPath;
    })
    .map(({ id }) => ({ id }));
}