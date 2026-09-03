"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCopilotLogLines } from "@/lib/parse-copilot-json-line";

interface CopilotRunEvent {
  type: "line" | "exit" | "error";
  data?: string;
  code?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  message?: string;
}

const MAX_VISIBLE_LOG_LINES = 2000;
const MAX_VISIBLE_LINE_CHARACTERS = 32 * 1024;

function splitVisibleLog(log: string): string[] {
  return log.split("\n").filter(Boolean).slice(-MAX_VISIBLE_LOG_LINES);
}

export default function LiveRunLog({
  runId,
  initialLog,
  isLive,
  outputFormat = "text",
}: {
  runId: string;
  initialLog: string;
  isLive: boolean;
  outputFormat?: "text" | "json";
}) {
  const [lines, setLines] = useState<string[]>(() => splitVisibleLog(initialLog));
  const [finished, setFinished] = useState(!isLive);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!isLive) return;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }

    let source: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      source = new EventSource(`/api/runs/${runId}/stream`);

      source.onmessage = (e) => {
        const event: CopilotRunEvent = JSON.parse(e.data);
        if (event.type === "line" && event.data) {
          setLines((prev) => [...prev, event.data!].slice(-MAX_VISIBLE_LOG_LINES));
        } else if (event.type === "exit" || event.type === "error") {
          stopped = true;
          setFinished(true);
          source.close();
          router.refresh();

          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            const title =
              event.type === "error"
                ? "Work Board run failed to start"
                : event.cancelled
                  ? "Work Board run cancelled"
                  : event.timedOut
                    ? "Work Board run timed out"
                    : event.code === 0
                      ? "Work Board run succeeded"
                      : "Work Board run failed";
            new Notification(title, { body: `Run ${runId.slice(0, 8)}` });
          }
        }
      };

      // A dropped connection (network blip, laptop sleep, etc.) isn't the same as the run
      // finishing — reconnect instead of leaving the UI stuck on "Live" forever.
      source.onerror = () => {
        source.close();
        if (!stopped) reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();

    // Safety net alongside SSE: periodically re-fetch the full persisted log and status
    // directly, in case an event was missed (e.g. a dropped connection reconnecting mid-line,
    // or any other gap) — this guarantees the view eventually matches what a manual reload shows,
    // without requiring the user to actually reload.
    const pollTimer = setInterval(async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/runs/${runId}?view=live`);
        if (!res.ok) return;
        const data: { log?: string; status?: string } = await res.json();
        if (typeof data.log === "string") {
          setLines(splitVisibleLog(data.log));
        }
        if (data.status && data.status !== "PENDING" && data.status !== "RUNNING") {
          stopped = true;
          setFinished(true);
          source.close();
          clearInterval(pollTimer);
          router.refresh();
        }
      } catch {
        // Ignore transient fetch failures; the next tick will retry.
      }
    }, 4000);

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(pollTimer);
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, isLive]);


  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [lines]);

  const displayLines = formatCopilotLogLines(lines, outputFormat).map((line) =>
    line.length > MAX_VISIBLE_LINE_CHARACTERS
      ? `${line.slice(0, MAX_VISIBLE_LINE_CHARACTERS)}\n[Entry truncated. Download stdout.log for the complete output.]`
      : line
  );

  return (
    <div>
      {!finished && (
        <p className="mb-2 inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase text-emerald-300">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
          </span>
          Live output
        </p>
      )}
      <div
        ref={containerRef}
        className="max-h-[500px] overflow-y-auto rounded-lg border border-neutral-800 bg-[var(--terminal-background)] p-4 font-mono text-xs leading-5 text-neutral-300 shadow-inner shadow-black/10"
      >
        {displayLines.length === 0 && <p className="text-neutral-500">Waiting for output...</p>}
        {displayLines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
