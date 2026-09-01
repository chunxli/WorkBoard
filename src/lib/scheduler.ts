import cron, { type ScheduledTask } from "node-cron";
import { prisma } from "@/lib/prisma";
import { jobQueue } from "@/lib/job-queue";
import { createPendingRun, executeRun } from "@/lib/task-executor";

type ScheduleConfig = { expression: string; repoId: string; waitForPreviousRuns: boolean };

const activeJobs = new Map<string, ScheduleConfig & { job: ScheduledTask }>();

async function triggerScheduledTask(taskId: string, repoId: string, waitForPreviousRuns: boolean) {
  const run = await createPendingRun(taskId, "SCHEDULE");
  jobQueue.enqueue(repoId, () => executeRun(run.id), waitForPreviousRuns);
}

/** Reconciles active node-cron jobs with the current set of enabled SCHEDULE tasks in the DB. */
export async function syncSchedules() {
  const tasks = await prisma.task.findMany({
    where: {
      triggerType: "SCHEDULE",
      enabled: true,
      archivedAt: null,
      cronExpression: { not: null },
    },
  });

  const desired = new Map(
    tasks.map((task) => [
      task.id,
      {
        expression: task.cronExpression!,
        repoId: task.repoId,
        waitForPreviousRuns: task.waitForPreviousRuns,
      } satisfies ScheduleConfig,
    ])
  );

  for (const [taskId, entry] of activeJobs) {
    const wanted = desired.get(taskId);
    if (
      !wanted ||
      wanted.expression !== entry.expression ||
      wanted.repoId !== entry.repoId ||
      wanted.waitForPreviousRuns !== entry.waitForPreviousRuns
    ) {
      entry.job.stop();
      activeJobs.delete(taskId);
    }
  }

  for (const [taskId, config] of desired) {
    if (activeJobs.has(taskId)) continue;
    if (!cron.validate(config.expression)) {
      console.error(`[scheduler] invalid cron expression for task ${taskId}: ${config.expression}`);
      continue;
    }
    const job = cron.schedule(config.expression, () => {
      triggerScheduledTask(taskId, config.repoId, config.waitForPreviousRuns).catch((err) =>
        console.error("[scheduler] trigger failed:", err)
      );
    });
    activeJobs.set(taskId, { ...config, job });
  }
}


let started = false;

/** Starts the periodic reconciliation loop once per server process. */
export function startScheduler() {
  if (started) return;
  started = true;
  syncSchedules().catch((err) => console.error("[scheduler] initial sync failed:", err));
  setInterval(() => {
    syncSchedules().catch((err) => console.error("[scheduler] sync failed:", err));
  }, 30_000);
}
