"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, RotateCcw, Search } from "lucide-react";
import StatusBadge from "@/components/StatusBadge";
import NextRunCountdown from "@/components/NextRunCountdown";

interface TaskRow {
  id: string;
  name: string;
  enabled: boolean;
  archivedAt: string | Date | null;
  triggerType: string;
  cronExpression: string | null;
  nextRunAt: string | null;
  repo: { name: string; hostname: string | null };
  runs: { status: string }[];
}

const TRIGGER_TYPES = ["MANUAL", "SCHEDULE", "WEBHOOK", "API"];

export default function TasksTable({ tasks }: { tasks: TaskRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [triggerFilter, setTriggerFilter] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (triggerFilter && task.triggerType !== triggerFilter) return false;
      if (!q) return true;
      return task.name.toLowerCase().includes(q) || task.repo.name.toLowerCase().includes(q);
    });
  }, [tasks, query, triggerFilter]);

  async function toggleEnabled(task: TaskRow) {
    setTogglingId(task.id);
    try {
      await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !task.enabled }),
      });
      router.refresh();
    } finally {
      setTogglingId(null);
    }
  }

  async function toggleArchived(task: TaskRow) {
    setTogglingId(task.id);
    try {
      await fetch(`/api/tasks/${task.id}/archive`, {
        method: task.archivedAt ? "DELETE" : "POST",
      });
      router.refresh();
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/45 p-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1 sm:min-w-64">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by automation or resource name..."
            className="ui-input w-full py-2 pl-9 pr-3 text-sm"
          />
        </div>
        <select
          value={triggerFilter}
          onChange={(e) => setTriggerFilter(e.target.value)}
          className="ui-input px-3 py-2 text-sm"
        >
          <option value="">All triggers</option>
          {TRIGGER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className="shrink-0 px-2 text-right font-mono text-[10px] text-neutral-500">
          {filtered.length} / {tasks.length}
        </span>
      </div>
      <div className="ui-table-shell">
        <table className="ui-table min-w-[980px]">
          <thead>
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Resource</th>
              <th className="px-4 py-2">Machine</th>
              <th className="px-4 py-2">Trigger</th>
              <th className="px-4 py-2">Enabled</th>
              <th className="px-4 py-2">Next run</th>
              <th className="px-4 py-2">Last run</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((task) => (
              <tr key={task.id}>
                <td className="px-4 py-2">
                  <Link href={`/tasks/${task.id}`} className="font-semibold text-neutral-100 hover:text-emerald-300">
                    {task.name}
                  </Link>
                </td>
                <td className="px-4 py-2 text-neutral-400">{task.repo.name}</td>
                <td className="px-4 py-2 font-mono text-xs text-neutral-400">{task.repo.hostname ?? "-"}</td>
                <td className="px-4 py-2 text-neutral-400">
                  {task.triggerType}
                  {task.triggerType === "SCHEDULE" && task.cronExpression && (
                    <span className="ml-1 font-mono text-xs">({task.cronExpression})</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => toggleEnabled(task)}
                    disabled={togglingId === task.id}
                    role="switch"
                    aria-checked={task.enabled}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] font-semibold disabled:opacity-50 ${
                      task.enabled
                        ? "border-emerald-800 bg-emerald-950/60 text-emerald-300 hover:bg-emerald-950"
                        : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                    }`}
                  >
                    <span className={`size-1.5 rounded-full ${task.enabled ? "bg-emerald-400" : "bg-neutral-500"}`} />
                    {task.enabled ? "ON" : "OFF"}
                  </button>
                </td>
                <td className="px-4 py-2">
                  <NextRunCountdown nextRun={task.nextRunAt} />
                </td>
                <td className="px-4 py-2">
                  {task.runs[0] ? <StatusBadge status={task.runs[0].status} /> : "-"}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => void toggleArchived(task)}
                    disabled={togglingId === task.id}
                    title={task.archivedAt ? "Restore automation" : "Archive automation"}
                    aria-label={task.archivedAt ? "Restore automation" : "Archive automation"}
                    className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-white disabled:opacity-50"
                  >
                    {task.archivedAt ? <RotateCcw size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-neutral-500">
                  No automations match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
