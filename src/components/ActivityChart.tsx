import { getRunStatusLabel } from "@/lib/work-run-status";

const STATUS_COLORS: Record<string, string> = {
  SUCCESS: "bg-emerald-600",
  FAILED: "bg-red-600",
  TIMED_OUT: "bg-amber-600",
  CANCELLED: "bg-neutral-500",
  RUNNING: "bg-blue-600",
  PENDING: "bg-neutral-400",
  UNKNOWN: "bg-amber-500",
};

export interface DayBucket {
  label: string;
  counts: Partial<Record<string, number>>;
  total: number;
}

export default function ActivityChart({ days }: { days: DayBucket[] }) {
  const maxTotal = Math.max(1, ...days.map((d) => d.total));

  return (
    <div className="flex items-end gap-2" style={{ height: 120 }}>
      {days.map((day) => (
        <div key={day.label} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex w-full flex-1 flex-col-reverse justify-start">
            {day.total === 0 ? (
              <div className="h-1 w-full rounded bg-neutral-700" />
            ) : (
              Object.entries(day.counts).map(([status, count]) => (
                <div
                  key={status}
                  className={`w-full ${STATUS_COLORS[status] ?? "bg-neutral-600"}`}
                  style={{ height: `${((count ?? 0) / maxTotal) * 96}px` }}
                  title={`${getRunStatusLabel(status)}: ${count}`}
                />
              ))
            )}
          </div>
          <span className="text-[10px] text-neutral-500">{day.label}</span>
        </div>
      ))}
    </div>
  );
}
