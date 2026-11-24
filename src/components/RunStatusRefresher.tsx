"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getRunStatusRevision, isRunStatusSnapshot, type RunStatusSnapshot } from "@/lib/work-run-status";
import PendingRunFeedback from "@/components/PendingRunFeedback";

export function isRunSnapshotActive(snapshot: Pick<RunStatusSnapshot, "status" | "displayStatus">): boolean {
  return snapshot.status === "PENDING" ||
    snapshot.status === "RUNNING" ||
    snapshot.displayStatus === "IN_TERMINAL" ||
    snapshot.displayStatus === "SYNCING";
}

export default function RunStatusRefresher({
  initialState,
  workId,
}: {
  initialState: RunStatusSnapshot;
  workId?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [observation, setObservation] = useState<RunStatusSnapshot | null>(null);
  const retry = useRef<() => void>(() => {});
  const runId = initialState.id;
  const initialRevision = getRunStatusRevision(initialState);
  const initialActive = isRunSnapshotActive(initialState);
  const polling = ["PENDING", "RUNNING", "UNKNOWN"].includes(initialState.status);
  const pending = initialState.displayStatus === "PENDING";
  const current = observation?.id === runId ? observation : initialState;

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let busy = false;
    let revision = initialRevision;
    let wasActive = initialActive;
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
        const nowActive = isRunSnapshotActive(body);
        if (wasActive && !nowActive) {
          wasActive = false;
          window.dispatchEvent(new CustomEvent("workboard:run-finished", {
            detail: { runId, ...(workId ? { workId } : {}) },
          }));
        } else {
          wasActive = nowActive;
        }
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
  }, [runId, workId, initialRevision, initialActive, pending, polling, router]);

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
