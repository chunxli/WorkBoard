function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-neutral-400";
  if (line.startsWith("+")) return "text-emerald-400";
  if (line.startsWith("-")) return "text-red-400";
  if (line.startsWith("@@")) return "text-blue-400";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-neutral-500";
  return "text-neutral-200";
}

/** Renders a unified git diff with per-line coloring (additions/removals/hunk headers). */
export default function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="max-h-[500px] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-950 p-4 font-mono text-xs">
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line || "\u00A0"}
        </div>
      ))}
    </pre>
  );
}
