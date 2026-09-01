"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";

export default function TriggerRunButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function onClick() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/run`, { method: "POST" });
      const body = await res.json();
      if (res.ok && body.runId) {
        router.push(`/runs/${body.runId}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={submitting}
      className="ui-primary-button"
    >
      <Play size={14} fill="currentColor" aria-hidden="true" />
      {submitting ? "Starting..." : "Run now"}
    </button>
  );
}
