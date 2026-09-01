import os from "node:os";
import path from "node:path";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import WorkBoard from "@/components/WorkBoard";
import LegacyMigrationPanel from "@/components/LegacyMigrationPanel";
import { canonicalizeWorkPath } from "@/lib/work-files";
import { getUserExecutionDefaults } from "@/lib/user-execution-defaults";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { getWorkRunDisplayStatus } from "@/lib/work-run-status";
import { isTerminalResumeReady } from "@/lib/terminal-resume";

export default async function WorkBoardPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const [works, resources, savedShortcuts, legacyTaskCount, executionDefaults] = await Promise.all([
    prisma.work.findMany({
      where: { userId },
      orderBy: [{ position: "asc" }, { updatedAt: "desc" }],
      include: {
        _count: { select: { tasks: true } },
        runs: {
          where: { experimentVariantId: null },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            taskId: true,
            status: true,
            trigger: true,
            copilotSessionId: true,
            hostname: true,
          },
        },
      },
    }),
    prisma.repo.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, location: true },
    }),
    prisma.workPathShortcut.findMany({
      where: { userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
    prisma.task.count({ where: { workId: null, repo: { userId } } }),
    getUserExecutionDefaults(userId),
  ]);

  const home = os.homedir();
  const requestHost = (await headers()).get("host") ?? "";
  const canUseLocalActions = localTerminalAvailable(requestHost);
  const localHostname = os.hostname();
  const workSummaries = await Promise.all(works.map(async (work) => {
    const latestRun = work.runs[0] ?? null;
    const runIsActive = latestRun?.status === "PENDING" || latestRun?.status === "RUNNING";
    let terminalResumeState: "ready" | "active" | "unavailable" = "unavailable";
    if (
      latestRun?.copilotSessionId &&
      canUseLocalActions &&
      (!latestRun.hostname || latestRun.hostname === localHostname) &&
      work.status !== "ARCHIVED"
    ) {
      if (runIsActive && latestRun.trigger === "TERMINAL_RESUME") {
        terminalResumeState = "active";
      } else if (!runIsActive && await isTerminalResumeReady({
        id: latestRun.id,
        taskId: latestRun.taskId,
        status: latestRun.status,
        work,
      })) {
        terminalResumeState = "ready";
      }
    }
    return {
      id: work.id,
      name: work.name,
      directoryPath: work.directoryPath,
      promptFileName: work.promptFileName,
      status: work.status,
      defaultEngine: work.defaultEngine,
      updatedAt: work.updatedAt.toISOString(),
      updatedAtLabel: work.updatedAt.toLocaleString("zh-CN", { hour12: false }),
      automationCount: work._count.tasks,
      latestRunStatus: getWorkRunDisplayStatus(latestRun),
      latestRunId: latestRun?.id ?? null,
      terminalResumeState,
    };
  }));
  const shortcuts = [
    ...savedShortcuts.map((shortcut) => ({
      id: shortcut.id,
      label: shortcut.label,
      path: shortcut.rootPath,
      builtIn: false,
    })),
    { id: "built-in-home", label: "Home", path: home, builtIn: true },
    {
      id: "built-in-desktop",
      label: "Desktop",
      path: path.join(home, "Desktop"),
      builtIn: true,
    },
  ].filter(
    (shortcut, index, all) =>
      all.findIndex(
        (candidate) => canonicalizeWorkPath(candidate.path) === canonicalizeWorkPath(shortcut.path)
      ) === index
  );

  return (
    <div className="space-y-6">
      <LegacyMigrationPanel count={legacyTaskCount} />
      <WorkBoard
        works={workSummaries}
        resources={resources}
        shortcuts={shortcuts}
        executionDefaults={executionDefaults}
        canOpenExplorer={canUseLocalActions}
      />
    </div>
  );
}