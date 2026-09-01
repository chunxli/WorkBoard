import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { getNextRunDate } from "@/lib/cron-next-run";
import TasksTable from "@/components/TasksTable";
import PageHeader from "@/components/PageHeader";
import { CalendarClock, Plus, Power, Workflow } from "lucide-react";

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const { view } = await searchParams;
  const archived = view === "archived";
  const tasks = await prisma.task.findMany({
    where: { repo: { userId }, archivedAt: archived ? { not: null } : null },
    orderBy: { createdAt: "desc" },
    include: { repo: true, runs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  const tasksWithNextRun = tasks.map((task) => ({
    ...task,
    nextRunAt:
      task.triggerType === "SCHEDULE" && task.enabled && task.cronExpression
        ? getNextRunDate(task.cronExpression)?.toISOString() ?? null
        : null,
  }));
  const enabledCount = tasks.filter((task) => task.enabled).length;
  const scheduledCount = tasks.filter((task) => task.triggerType === "SCHEDULE").length;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Scheduled work" title="Automations">
        {!archived && (
          <Link
            href="/tasks/new"
            className="ui-primary-button"
          >
            <Plus size={16} aria-hidden="true" />
            New automation
          </Link>
        )}
      </PageHeader>
      <div className="grid grid-cols-3 divide-x divide-neutral-800 border-y border-neutral-800 py-3">
        {[
          { label: "Visible", value: tasks.length, icon: Workflow },
          { label: "Enabled", value: enabledCount, icon: Power },
          { label: "Scheduled", value: scheduledCount, icon: CalendarClock },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex items-center gap-3 px-3 first:pl-0 sm:px-5 sm:first:pl-0">
            <span className="hidden size-8 place-items-center rounded-md bg-neutral-900 text-neutral-500 sm:grid">
              <Icon size={14} aria-hidden="true" />
            </span>
            <div>
              <div className="font-mono text-base font-bold text-neutral-100">{value}</div>
              <div className="text-[10px] font-semibold uppercase text-neutral-500">{label}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex w-fit rounded-md border border-neutral-800 bg-neutral-950 p-1 text-xs font-medium">
        <Link href="/tasks" className={`rounded px-3 py-1.5 ${!archived ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}>Current</Link>
        <Link href="/tasks?view=archived" className={`rounded px-3 py-1.5 ${archived ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}>Archived</Link>
      </div>
      <TasksTable tasks={tasksWithNextRun} />
    </div>
  );
}
