"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Square } from "lucide-react";

export default function CancelRunButton({ runId, compact = false }: { runId: string; compact?: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);

  async function onClick() {
    if (!confirm("Cancel this run?")) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : "Run cancellation could not be confirmed.");
      }
      if (response.status === 202) {
        setFeedback({ message: "Stop requested. This Work stays reserved until exit is confirmed.", error: false });
      }
      router.refresh();
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : "Run cancellation could not be confirmed.", error: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        onClick={onClick}
        disabled={submitting}
        type="button"
        title={compact ? submitting ? "Cancelling..." : "Cancel run" : undefined}
        className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber-800 py-1 text-xs font-medium text-amber-300 hover:bg-amber-950/60 disabled:opacity-50 ${compact ? "size-8 justify-center" : "px-2.5"}`}
      >
        <Square size={11} fill="currentColor" aria-hidden="true" />
        <span className={compact ? "sr-only" : undefined}>{submitting ? "Cancelling..." : "Cancel run"}</span>
      </button>
      {feedback && <span role={feedback.error ? "alert" : "status"} className="absolute right-0 top-full z-20 mt-1 w-56 rounded border border-amber-800 bg-neutral-950 p-2 text-xs text-amber-200">
        {feedback.message}
      </span>}
    </span>
  );
}
