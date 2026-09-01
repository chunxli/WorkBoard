import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import type { RunStatus } from "@/generated/prisma/client";
import StatusBadge from "@/components/StatusBadge";
import RunStatusFilter from "@/components/RunStatusFilter";
import CancelRunButton from "@/components/CancelRunButton";
import { formatDuration } from "@/lib/format";
import { ownedRunWhere } from "@/lib/run-access";
import PageHeader from "@/components/PageHeader";

const PAGE_SIZE = 20;
const VALID_STATUSES = new Set(["PENDING", "RUNNING", "SUCCESS", "FAILED", "TIMED_OUT", "CANCELLED"]);

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const { status, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const where = {
    ...ownedRunWhere(userId),
    ...(status && VALID_STATUSES.has(status) ? { status: status as RunStatus } : {}),
  };

  const [runs, total] = await Promise.all([
    prisma.run.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        task: { select: { id: true, name: true, repo: { select: { hostname: true } } } },
        work: { select: { id: true, name: true } },
      },
    }),
    prisma.run.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const query = status ? `&status=${status}` : "";

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Execution history" title="Runs">
        <span className="font-mono text-xs text-neutral-500">{total} runs</span>
        <RunStatusFilter />
      </PageHeader>
      <div className="ui-table-shell">
        <table className="ui-table min-w-[920px]">
          <thead>
            <tr>
              <th className="px-4 py-2">Work / Automation</th>
              <th className="px-4 py-2">Machine</th>
              <th className="px-4 py-2">Trigger</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Started</th>
              <th className="px-4 py-2">Duration</th>
              <th className="px-4 py-2">PID</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const isLive = run.status === "PENDING" || run.status === "RUNNING";
              return (
                <tr key={run.id}>
                  <td className="px-4 py-2">
                    <Link href={`/runs/${run.id}`} className="font-semibold text-neutral-100 hover:text-emerald-300">
                      {run.work?.name ?? run.task?.name ?? "Unknown run"}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-400">
                    {run.hostname ?? run.task?.repo.hostname ?? "-"}
                  </td>
                  <td className="px-4 py-2 text-neutral-400">{run.trigger}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-2 text-neutral-400">
                    {run.startedAt ? new Date(run.startedAt).toLocaleString() : "-"}
                  </td>
                  <td className="px-4 py-2 text-neutral-400">
                    {formatDuration(run.startedAt, run.finishedAt)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-400">{run.pid ?? "-"}</td>
                  <td className="px-4 py-2 text-right">{isLive && <CancelRunButton runId={run.id} />}</td>
                </tr>
              );
            })}
            {runs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-neutral-500">
                  No runs found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-neutral-400">
          <span>
            Page {page} of {totalPages} ({total} runs)
          </span>
          <div className="flex gap-2">
            <Link
              href={`/runs?page=${page - 1}${query}`}
              aria-disabled={page <= 1}
                className={`ui-secondary-button min-h-0 px-3 py-1 ${
                page <= 1 ? "pointer-events-none opacity-40" : ""
              }`}
            >
              Prev
            </Link>
            <Link
              href={`/runs?page=${page + 1}${query}`}
              aria-disabled={page >= totalPages}
                className={`ui-secondary-button min-h-0 px-3 py-1 ${
                page >= totalPages ? "pointer-events-none opacity-40" : ""
              }`}
            >
              Next
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
