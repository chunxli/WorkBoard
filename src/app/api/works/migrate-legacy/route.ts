import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRepoWorkdir } from "@/lib/repo-workdir";
import { getSessionUserId } from "@/lib/session";
import { provisionWorkDirectory, unregisterWorkDirectory } from "@/lib/work-files";

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tasks = await prisma.task.findMany({
    where: { workId: null, repo: { userId } },
    orderBy: [{ repoId: "asc" }, { createdAt: "asc" }],
    include: { repo: true },
  });
  const migrated: Array<{ taskId: string; workId: string; promptFileName: string }> = [];
  const failed: Array<{ taskId: string; error: string }> = [];

  for (const task of tasks) {
    const workId = randomUUID();
    let diskRecord: Awaited<ReturnType<typeof provisionWorkDirectory>> | null = null;
    try {
      const directoryPath = await resolveRepoWorkdir(task.repo);
      diskRecord = await provisionWorkDirectory({
        workId,
        name: task.name,
        directoryPath,
        prompt: task.prompt,
      });
      await prisma.$transaction([
        prisma.work.create({
          data: {
            id: workId,
            userId,
            sourceRepoId: task.repoId,
            name: task.name,
            directoryPath: diskRecord.directoryPath,
            canonicalPath: diskRecord.canonicalPath,
            promptFileName: diskRecord.promptFileName,
            promptCache: task.prompt,
            promptHash: diskRecord.promptHash,
            hostname: hostname(),
          },
        }),
        prisma.task.update({
          where: { id: task.id, workId: null },
          data: { workId },
        }),
        prisma.run.updateMany({
          where: { taskId: task.id },
          data: { workId },
        }),
      ]);
      migrated.push({ taskId: task.id, workId, promptFileName: diskRecord.promptFileName });
    } catch (error) {
      if (diskRecord) await unregisterWorkDirectory(diskRecord);
      failed.push({
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json(
    { migrated, failed },
    { status: failed.length > 0 && migrated.length === 0 ? 500 : 200 }
  );
}