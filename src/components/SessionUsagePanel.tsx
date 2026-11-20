import type { SessionUsage, SessionUsageEntry } from "@/lib/session-usage";

function FailedCount({ count = 0 }: { count?: number }) {
  if (!count) return null;
  const description = `${count} failed ${count === 1 ? "call" : "calls"}`;
  return <span className="ms-1 font-semibold text-red-400" title={description}>
    <span aria-hidden="true">({count})</span>
    <span className="sr-only">, {description}</span>
  </span>;
}

function UsageGroup({ label, entries }: { label: "MCP" | "Skills"; entries: (SessionUsageEntry & { failedCount?: number })[] }) {
  const hasFailures = entries.some(({ failedCount }) => Boolean(failedCount));
  return <section aria-label={label} className="min-w-0">
    <h3 className="mb-1 font-semibold text-neutral-300"
      title={label === "MCP" ? "Total recorded calls, not successful calls" : "Recorded Skill invocations; no separate outcome is reported"}>{label}</h3>
    {hasFailures && <p className="mb-1 text-[10px] text-neutral-300">Total (failed)</p>}
    {entries.length === 0 ? <p className="text-neutral-400">None recorded</p>
      : <ul className="space-y-1">
        {entries.map(({ name, count, failedCount }) => <li key={name} className="flex items-start justify-between gap-1.5">
          <span className="min-w-0 wrap-anywhere" title={name}>{name}</span>{" "}
          <span className="shrink-0 font-semibold tabular-nums text-neutral-100">
            {count}<span className="sr-only"> {count === 1 ? "total call" : "total calls"}</span>
            <FailedCount count={failedCount} />
          </span>
        </li>)}
      </ul>}
  </section>;
}

export default function SessionUsagePanel({ usage, expanded = false, disclosureGroup }: {
  usage: SessionUsage | null; expanded?: boolean; disclosureGroup?: string;
}) {
  return <aside aria-label="Session usage" className="work-session-usage">
    <details name={disclosureGroup} open={expanded || undefined}>
      <summary className="cursor-pointer rounded-sm py-1 font-semibold text-neutral-300">
        Session usage
        {!expanded && usage && <>{" "}<span className="ms-2 font-normal tabular-nums text-neutral-400">
          MCP {usage.mcp.reduce((total, entry) => total + entry.count, 0)}
          <FailedCount count={usage.mcp.reduce((total, entry) => total + entry.failedCount, 0)} />{" · "}
          Skills {usage.skills.reduce((total, entry) => total + entry.count, 0)}
        </span></>}
      </summary>
      <div className="work-session-usage-content py-1" role="group" aria-label="Recorded calls" tabIndex={0}>
        {usage ? <>
          <div className="work-session-usage-groups">
            <UsageGroup label="MCP" entries={usage.mcp} />
            <UsageGroup label="Skills" entries={usage.skills} />
          </div>
          {usage.partial && <p className="mt-2 text-amber-300">Some session records could not be counted.</p>}
        </> : <p className="text-neutral-400">Session usage is unavailable.</p>}
      </div>
    </details>
  </aside>;
}
