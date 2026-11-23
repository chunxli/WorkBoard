import { Clock3, LoaderCircle } from "lucide-react";
import { pendingRunTitle, type WorkRunPreparation } from "@/lib/work-run-status";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const units = ["B", "KB", "MB", "GB", "TB"];

function readSize(bytes: number) {
  let unit = 0;
  while (bytes >= 1000 && unit < units.length - 1) {
    bytes /= 1000;
    unit++;
  }
  return `${number.format(bytes)} ${units[unit]}`;
}

export default function PendingRunFeedback({ preparation }: { preparation?: WorkRunPreparation }) {
  const progress = preparation?.phase === "snapshot" ? preparation.progress : undefined;
  const Icon = preparation ? LoaderCircle : Clock3;
  return (
    <section aria-label="Run preparation" className="shrink-0 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-xs">
      <p role="status" className="flex items-center gap-2 font-semibold text-neutral-200">
        <Icon size={14} className={preparation ? "shrink-0 text-emerald-500 motion-safe:animate-spin" : "shrink-0 text-neutral-400"} aria-hidden="true" />
        {pendingRunTitle(preparation)}
      </p>
      <p className="mt-1 text-neutral-400">
        {preparation?.phase === "snapshot"
          ? "Work Board is recording the workspace to track file changes. Large files can take longer. "
          : preparation ? "Work Board is preparing this Run. " : "No preparation step has been reported yet. "}
        Copilot has not started for this Run.
      </p>
      {progress && (
        <p className="mt-1 font-mono tabular-nums text-neutral-300">
          {number.format(progress.filesScanned)} {progress.filesScanned === 1 ? "file" : "files"} scanned
          {" · "}{readSize(progress.bytesRead)} read
        </p>
      )}
    </section>
  );
}
