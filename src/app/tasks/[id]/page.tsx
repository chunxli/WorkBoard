import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { formatDuration } from "@/lib/format";
import { getNextRunDate } from "@/lib/cron-next-run";
import StatusBadge from "@/components/StatusBadge";
import TriggerRunButton from "@/components/TriggerRunButton";
import DeleteButton from "@/components/DeleteButton";
import CancelRunButton from "@/components/CancelRunButton";
import NextRunCountdown from "@/components/NextRunCountdown";
import MetaChip from "@/components/MetaChip";
import SectionHeading from "@/components/SectionHeading";
import { ArrowLeft, Bot, Boxes, CalendarClock, History, MessageSquareText, Monitor, Pencil, Power, Zap } from "lucide-react";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const { id } = await params;
  const task = await prisma.task.findFirst({
    where: { id, repo: { userId } },
    include: { repo: true, runs: { orderBy: { createdAt: "desc" } } },
  });
  if (!task) notFound();

  const nextRunAt =
    task.triggerType === "SCHEDULE" && task.enabled && task.cronExpression
      ? getNextRunDate(task.cronExpression)?.toISOString() ?? null
      : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 border-b border-neutral-800 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href="/tasks" className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500 hover:text-emerald-300">
            <ArrowLeft size={13} aria-hidden="true" />
            Automations
          </Link>
          <p className="mt-2 text-[11px] font-bold uppercase text-emerald-400">Automation</p>
          <h1 className="mt-2 text-2xl font-bold text-white">{task.name}</h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <MetaChip icon={Boxes}>{task.repo.name}</MetaChip>
            <MetaChip icon={Zap}>{task.triggerType}</MetaChip>
            <MetaChip icon={Power}>{task.enabled ? "Enabled" : "Disabled"}</MetaChip>
            <MetaChip icon={Bot}>{task.model ?? "Auto model"}</MetaChip>
            {task.repo.hostname && <MetaChip icon={Monitor} mono>{task.repo.hostname}</MetaChip>}
            {task.cronExpression && <MetaChip icon={CalendarClock} mono>{task.cronExpression}</MetaChip>}
            {task.triggerType === "SCHEDULE" && (
              <MetaChip icon={CalendarClock}>
                {task.enabled ? <NextRunCountdown nextRun={nextRunAt} /> : "Not scheduled"}
              </MetaChip>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <TriggerRunButton taskId={task.id} />
          <Link
            href={`/tasks/${task.id}/edit`}
            className="ui-secondary-button"
          >
            <Pencil size={14} aria-hidden="true" />
            Edit
          </Link>
          <DeleteButton url={`/api/tasks/${task.id}`} label="Delete automation" />
        </div>
      </header>

      <section>
        <SectionHeading icon={MessageSquareText} title="Prompt" />
        <div className="ui-panel p-4 sm:p-5">
          <pre className="whitespace-pre-wrap border-l-2 border-emerald-700 pl-4 text-sm leading-6 text-neutral-200">{task.prompt}</pre>
        </div>
      </section>

      <section>
        <SectionHeading icon={History} title="Run history" />
        <div className="ui-table-shell">
          <table className="ui-table min-w-[680px]">
            <thead>
              <tr>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {task.runs.map((run) => {
                const isLive = run.status === "PENDING" || run.status === "RUNNING";
                return (
                  <tr key={run.id}>
                    <td className="px-4 py-2">
                      <Link href={`/runs/${run.id}`} className="font-semibold text-neutral-100 hover:text-emerald-300">
                        {run.trigger}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-2 text-neutral-400">
                      {run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}
                    </td>
                    <td className="px-4 py-2 text-neutral-400">
                      {formatDuration(run.startedAt, run.finishedAt)}
                    </td>
                    <td className="px-4 py-2 text-right">{isLive && <CancelRunButton runId={run.id} />}</td>
                  </tr>
                );
              })}
              {task.runs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-neutral-500">
                    No runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
