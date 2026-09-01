"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function TerminalSessionActions({
  runId,
  canResume,
  canSync,
}: {
  runId: string;
  canResume: boolean;
  canSync: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"resume" | "sync" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function invoke(action: "resume" | "sync") {
    setBusy(action);
    setError(null);
    try {
      const endpoint = action === "resume" ? "resume-terminal" : "sync-session";
      const response = await fetch(`/api/runs/${runId}/${endpoint}`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Action failed");
      if (action === "resume" && body.runId) router.push(`/runs/${body.runId}`);
      else router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canResume && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void invoke("resume")}
          className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy === "resume" ? "Opening..." : "Resume in terminal"}
        </button>
      )}
      {canSync && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void invoke("sync")}
          className="rounded border border-neutral-600 px-3 py-2 text-sm hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy === "sync" ? "Syncing..." : "Sync session"}
        </button>
      )}
      {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
    </div>
  );
}