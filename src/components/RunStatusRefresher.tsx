"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getRunStatusRevision, isRunStatusSnapshot, type RunStatusSnapshot } from "@/lib/work-run-status";
import PendingRunFeedback from "@/components/PendingRunFeedback";

export default function RunStatusRefresher({ initialState }: { initialState: RunStatusSnapshot }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [observation, setObservation] = useState<RunStatusSnapshot | null>(null);
  const retry = useRef<() => void>(() => {});
  const runId = initialState.id;
  const initialRevision = getRunStatusRevision(initialState);
  const polling = ["PENDING", "RUNNING", "UNKNOWN"].includes(initialState.status);
  const pending = initialState.displayStatus === "PENDING";
  const current = observation?.id === runId ? observation : initialState;

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let busy = false;
    let revision = initialRevision;
    async function load() {
      if (stopped || busy || document.hidden) return;
      busy = true;
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}?view=status`, {
          cache: "no-store", signal: controller.signal,
        });
        const body: unknown = await response.json();
        if (stopped) return;
        if (!response.ok) {
          throw new Error(
            body !== null && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error : "Unable to refresh Run status",
          );
        }
        if (!isRunStatusSnapshot(body) || body.id !== runId) throw new Error("Invalid Run status response");
        setError(null);
        if (pending) setObservation(body);
        const nextRevision = getRunStatusRevision(body);
        if (nextRevision !== revision) {
          revision = nextRevision;
          router.refresh();
        }
      } catch (reason) {
        if (!stopped && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Unable to refresh Run status");
        }
      } finally {
        busy = false;
      }
    }
    const refresh = () => { void load(); };
    retry.current = refresh;
    refresh();
    const timer = polling ? setInterval(refresh, 4000) : undefined;
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [runId, initialRevision, pending, polling, router]);

  if (!error && pending && current.displayStatus === "PENDING") {
    return <PendingRunFeedback preparation={current.preparation} />;
  }
  return error ? (
    <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-400">
      Status refresh failed: {error}
      <button type="button" className="underline hover:text-red-300" onClick={() => retry.current()}>Retry</button>
    </p>
  ) : null;
}
