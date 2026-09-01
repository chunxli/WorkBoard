"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Square } from "lucide-react";

export default function CancelRunButton({ runId }: { runId: string }) {
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
      className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber-800 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-950/60 disabled:opacity-50"
    >
      <Square size={11} fill="currentColor" aria-hidden="true" />
      {submitting ? "Cancelling..." : "Cancel run"}
    </button>
  );
}
