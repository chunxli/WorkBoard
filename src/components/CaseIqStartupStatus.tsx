"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  caseIqStartupObservationSchema, caseIqStartupPhases, type CaseIqStartupObservation,
} from "@/lib/caseiq-startup";
import { formatDuration } from "@/lib/format";

export function CaseIqStartupFeedback({ observation, error, now, onShowLogs, onRetry, toolActivityAt = [] }: {
  observation: CaseIqStartupObservation | null; error: string | null; now: number;
  onShowLogs?: () => void; onRetry: () => void;
  toolActivityAt?: readonly string[];
}) {
  if (observation && !["PENDING", "RUNNING"].includes(observation.status)) return null;
  const startup = observation?.startup;
  const unavailable = error ?? observation?.unavailableReason;
  const attemptStartedAt = startup ? Date.parse(startup.startedAt) : null;
  if (!unavailable && observation?.status === "RUNNING" && startup?.phase !== "stopping" &&
      attemptStartedAt !== null && toolActivityAt.some((at) => Date.parse(at) >= attemptStartedAt)) return null;
  const phase = startup ? caseIqStartupPhases[startup.phase] : null;
  const initializing = startup && !["processing", "stopping"].includes(startup.phase);
  const waiting = !observation || observation.status === "PENDING" || Boolean(startup);
  const label = unavailable ? "CaseIQ startup state unavailable"
    : phase?.label ?? (observation?.status === "PENDING" ? "CaseIQ is queued" : "Checking CaseIQ startup...");
  return <section aria-label="CaseIQ Run startup status" className="shrink-0 rounded-md border border-neutral-800 px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {!unavailable && waiting && <LoaderCircle size={14} className="shrink-0 animate-spin text-emerald-500 motion-reduce:animate-none" aria-hidden="true" />}
      <p role="status" aria-live="polite" className="min-w-0 flex-1 font-semibold text-neutral-300">{label}</p>
      {(startup || observation) && <span className="shrink-0 tabular-nums text-neutral-500" aria-label="Time in the current startup attempt">
        {formatDuration(startup?.startedAt ?? observation?.startedAt ?? null, null, now)}
      </span>}
      {onShowLogs && <button type="button" onClick={onShowLogs} className="ui-subtle-button">
        {startup?.phase === "processing" ? "View Run output" : "View startup logs"}
      </button>}
    </div>
    {unavailable ? <p role="alert" className="mt-1 break-words text-amber-500">{unavailable}{" "}
      <button type="button" onClick={onRetry} className="ui-subtle-button">Retry check</button>
    </p> : (startup?.phase !== "processing") && <p className="mt-1 break-words text-neutral-500">
      {phase?.detail ?? (observation?.status === "PENDING"
        ? "Waiting for this Run's worker. Earlier messages belong to the same Session, not this new Run."
        : "Checking this Run's live startup state. Earlier conversation messages do not hide its initialization.")}
    </p>}
    {!unavailable && initializing && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-neutral-500" aria-label="Reported startup stages">
      {startup.steps.map((step, index) => <span key={`${index}:${step.phase}`} className={index === startup.steps.length - 1 ? "text-emerald-500" : ""}>
        {index + 1}. {caseIqStartupPhases[step.phase].label}
      </span>)}
      {startup.attempt > 1 && <span>Attempt {startup.attempt} in the same Run/Session</span>}
    </div>}
  </section>;
}

export default function CaseIqStartupStatus({ runId, onShowLogs, toolActivityAt }: {
  runId: string; onShowLogs?: () => void; toolActivityAt?: readonly string[];
}) {
  const [observation, setObservation] = useState<CaseIqStartupObservation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let finished = false;
    let controller: AbortController | null = null;
    const check = async () => {
      if (disposed || pending || finished) return;
      pending = true;
      controller = new AbortController();
      const request = controller;
      const timeout = setTimeout(() => request.abort(), 10_000);
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}?view=startup`, {
          cache: "no-store", signal: request.signal,
        });
        if (!response.ok) throw new Error(`Startup status check failed (HTTP ${response.status}). View this Run's output or retry.`);
        const value = caseIqStartupObservationSchema.parse(await response.json());
        if (value.runId !== runId) throw new Error("The startup response belongs to a different Run. Refresh before relying on its state.");
        if (disposed) return;
        finished = !["PENDING", "RUNNING"].includes(value.status);
        setObservation(value); setError(null); setNow(Date.now());
      } catch (reason) {
        if (!disposed) setError(request.signal.aborted
          ? "The startup status check timed out. View this Run's output or retry."
          : reason instanceof Error ? reason.message : "The startup state could not be checked.");
      } finally {
        clearTimeout(timeout);
        pending = false;
      }
    };
    const tick = () => {
      if (document.hidden) return;
      setNow(Date.now());
      void check();
    };
    retry.current = () => { setNow(Date.now()); void check(); };
    void check();
    const timer = setInterval(tick, 1500);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      disposed = true; controller?.abort(); clearInterval(timer);
      retry.current = () => {};
      window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick);
    };
  }, [runId]);
  return <CaseIqStartupFeedback observation={observation?.runId === runId ? observation : null}
    error={error} now={now} onShowLogs={onShowLogs} onRetry={() => retry.current()} toolActivityAt={toolActivityAt} />;
}
