import { getRunStatusLabel } from "@/lib/work-run-status";

const colors: Record<string, { badge: string; dot: string }> = {
  PENDING: { badge: "border-neutral-700 bg-neutral-800/70 text-neutral-300", dot: "bg-neutral-400" },
  RUNNING: { badge: "border-blue-800 bg-blue-950/60 text-blue-300", dot: "bg-blue-400" },
  IN_TERMINAL: { badge: "border-emerald-800 bg-emerald-950/60 text-emerald-300", dot: "bg-emerald-400" },
  UNKNOWN: { badge: "border-amber-800 bg-amber-950/60 text-amber-300", dot: "bg-amber-400" },
  SUCCESS: { badge: "border-emerald-800 bg-emerald-950/60 text-emerald-300", dot: "bg-emerald-400" },
  FAILED: { badge: "border-red-900 bg-red-950/60 text-red-300", dot: "bg-red-400" },
  TIMED_OUT: { badge: "border-amber-900 bg-amber-950/60 text-amber-300", dot: "bg-amber-400" },
  CANCELLED: { badge: "border-neutral-700 bg-neutral-900 text-neutral-400", dot: "bg-neutral-500" },
};

export default function StatusBadge({ status }: { status: string }) {
  const style = colors[status] ?? colors.PENDING;
  const active = status === "RUNNING" || status === "IN_TERMINAL";
  const label = getRunStatusLabel(status);
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] font-semibold ${style.badge}`}
    >
      <span className="relative flex size-1.5">
        {active && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${style.dot}`} />}
        <span className={`relative inline-flex size-1.5 rounded-full ${style.dot}`} />
      </span>
      {label}
    </span>
  );
}
