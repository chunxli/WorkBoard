"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Square } from "lucide-react";

export default function CancelRunButton({ runId, compact = false }: { runId: string; compact?: boolean }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function onClick() {
    if (!confirm("Cancel this run?")) return;
    setSubmitting(true);
    try {
      await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
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
  );
}
