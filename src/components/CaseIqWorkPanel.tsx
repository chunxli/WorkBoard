"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, RefreshCw, RotateCcw, Terminal, X } from "lucide-react";
import {
  CASEIQ_MAX_PACKS, caseIqLaunchSchema, caseIqPendingTerminalKey, caseIqStatusSchema,
  classifyCaseIqTerminalResponse, clearCaseIqPendingTerminal, readCaseIqPendingTerminal,
  rememberCaseIqPendingTerminal, type CaseIqPendingTerminal, type CaseIqStatus, type CaseIqTerminalReceipt,
} from "@/lib/caseiq-options";

export default function CaseIqWorkPanel({
  workId, disabledReason = null,
}: { workId: string; disabledReason?: string | null }) {
  const router = useRouter();
  const [status, setStatus] = useState<CaseIqStatus | null>(null);
  const [packs, setPacks] = useState<string[]>([]);
  const [packQuery, setPackQuery] = useState("");
  const [caseNumber, setCaseNumber] = useState("");
  const [sendPrompt, setSendPrompt] = useState(false);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<"new" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [receipt, setReceipt] = useState<CaseIqTerminalReceipt | null>(null);
  const launchBusy = useRef(false);

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/works/${workId}/caseiq`, { cache: "no-store", signal });
    if (!response.ok) throw new Error("CaseIQ environment could not be checked.");
    const value = caseIqStatusSchema.safeParse(await response.json());
    if (!value.success) throw new Error("CaseIQ returned an invalid environment report.");
    return value.data;
  }, [workId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      try { setUnconfirmed(readCaseIqPendingTerminal(sessionStorage, workId) !== null); }
      catch (reason) {
        setUnconfirmed(true);
        setError(`The previous CaseIQ request record could not be verified: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
      return loadStatus(controller.signal);
    }).then((value) => {
      if (value && !controller.signal.aborted) { setStatus(value); setStatusError(null); }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setStatusError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadStatus, workId]);

  const activeSession = status?.lastSession?.resumeState === "active";
  useEffect(() => {
    if (!activeSession) return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const value = await loadStatus(controller.signal);
        if (!controller.signal.aborted) { setStatus(value); setStatusError(null); }
      } catch (reason) {
        if (!controller.signal.aborted) setStatusError(reason instanceof Error ? reason.message : String(reason));
      } finally { checking = false; }
    }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [activeSession, loadStatus]);

  async function refresh() {
    setLoading(true);
    setStatusError(null);
    try { setStatus(await loadStatus()); }
    catch (reason) { setStatusError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }

  async function openTerminal(endpoint: string, action: "new" | "resume", body?: object) {
    if (launchBusy.current || unconfirmed) {
      setError("A CaseIQ request is pending or unconfirmed. Check Terminal and Run history before trying again.");
      return;
    }
    launchBusy.current = true;
    setLaunching(action);
    setError(null);
    setReceipt(null);
    let dispatched = false;
    let accepted = false;
    try {
      const request: CaseIqPendingTerminal = { requestId: crypto.randomUUID(), action };
      rememberCaseIqPendingTerminal(sessionStorage, workId, request);
      dispatched = true;
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = classifyCaseIqTerminalResponse(response.status, await response.text());
      if (result.state === "unconfirmed") {
        setUnconfirmed(true);
        setError(result.message);
        router.refresh();
        await refresh();
        return;
      }
      if (result.state === "accepted") {
        accepted = true;
        setReceipt(result.receipt);
        setError(null);
      }
      if (!clearCaseIqPendingTerminal(sessionStorage, workId, request.requestId)) {
        throw new Error("A different CaseIQ request remains unconfirmed in this browser tab.");
      }
      if (result.state === "rejected") { setError(result.message); return; }
      router.refresh();
      await refresh();
    } catch (reason) {
      setUnconfirmed(true);
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`${accepted ? "CaseIQ accepted the request, but local confirmation needs review."
        : dispatched ? "CaseIQ launch acceptance is unconfirmed. The Terminal may already be open."
          : "The request was not sent because the browser launch guard could not be recorded."} ${detail}`);
    } finally { launchBusy.current = false; setLaunching(null); }
  }

  function acknowledgeUnconfirmed() {
    try {
      sessionStorage.removeItem(caseIqPendingTerminalKey(workId));
      setUnconfirmed(false);
      setError(null);
    } catch (reason) {
      setError(`The browser launch guard could not be cleared: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  function launch(event: React.FormEvent) {
    event.preventDefault();
    if (loading || statusError !== null || !status?.launchable || disabledReason !== null) {
      setError(disabledReason ?? statusError ?? status?.reason ?? "Check the CaseIQ environment before opening Terminal.");
      return;
    }
    if (activeSession) {
      setError("The previous CaseIQ Run still reserves this Work. Check its native Terminal and Run details before starting another session.");
      return;
    }
    if (packs.some((id) => !status.packs.some((pack) => pack.id === id))) {
      setError(`Select up to ${CASEIQ_MAX_PACKS} currently available CaseIQ support packs.`);
      return;
    }
    const options = caseIqLaunchSchema.safeParse({
      packs, caseNumber: caseNumber.trim() || null, sendPrompt,
    });
    if (!options.success) {
      setError(`Select at most ${CASEIQ_MAX_PACKS} packs. Case numbers may contain only letters, digits, dot, underscore or hyphen (up to 200 characters).`);
      return;
    }
    void openTerminal(`/api/works/${encodeURIComponent(workId)}/caseiq`, "new", options.data);
  }

  function reuseConfiguration() {
    const configuration = status?.lastSession?.configuration;
    if (!configuration) {
      setError("No verified previous CaseIQ settings are available.");
      return;
    }
    setPacks([...configuration.packs]);
    setCaseNumber(configuration.caseNumber ?? "");
    setSendPrompt(false);
    setError(configuration.packs.some((id) => !status?.packs.some((pack) => pack.id === id))
      ? "Some previous packs are unavailable. Review the selection before opening a new session." : null);
  }

  function resumeSession() {
    const session = status?.lastSession;
    if (!session || session.resumeState !== "ready" || loading || statusError !== null || disabledReason !== null) {
      setError("This CaseIQ session cannot be resumed yet. Retry the environment check.");
      return;
    }
    void openTerminal(`/api/runs/${encodeURIComponent(session.runId)}/resume-terminal`, "resume");
  }

  const query = packQuery.trim().toLowerCase();
  const matchingPacks = status?.packs.filter((pack) => `${pack.id} ${pack.name}`.toLowerCase().includes(query)) ?? [];
  const matchingIds = new Set(matchingPacks.map((pack) => pack.id));
  const visiblePacks = status?.packs.filter((pack) => packs.includes(pack.id) || matchingIds.has(pack.id)) ?? [];

  return (
    <section className="space-y-4 p-4" aria-label="CaseIQ integration">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">CaseIQ</h2>
          <p className="mt-1 text-xs text-amber-300">Native Terminal fallback · no SDK session control</p>
        </div>
        <Link href="/docs/caseiq" className="ui-secondary-button text-xs"><BookOpen size={13} />Integration guide</Link>
      </header>
      <p className="text-sm text-neutral-400">
        Run the original CaseIQ launcher with its own packs, telemetry and approvals.
        Questions, sign-in and tool permissions stay in native Terminal. WorkBoard reads the same bound session history.
      </p>
      <p role="status" className="text-xs text-neutral-400">
        {loading ? "Checking the local installation without creating a model session..."
          : statusError ? "The latest environment check failed. Retry the check before opening or resuming Terminal."
          : status?.launchable ? "Native launcher is available. This is not a guarantee of package access or model readiness."
            : status?.reason ?? "CaseIQ installation has not been checked."}
      </p>
      {status?.webExecution && <p className="rounded-md border border-amber-900/60 p-3 text-xs text-amber-200">{status.webExecution.reason}</p>}
      {status?.warnings.length ? <ul className="list-disc space-y-1 pl-4 text-xs text-neutral-500">
        {status.warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul> : null}
      {receipt && <p role="status" className="rounded-md border border-emerald-900/60 p-3 text-xs text-emerald-300">
        CaseIQ Terminal request accepted. <Link href={`/runs/${encodeURIComponent(receipt.runId)}`} className="underline">View accepted Run</Link>.
        {" "}This does not prove that native setup or the task has completed.
      </p>}
      {unconfirmed && <section role="alert" className="space-y-2 rounded-md border border-amber-900/60 p-3 text-xs text-amber-200" aria-label="Unconfirmed CaseIQ request">
        <p>A previous CaseIQ request is unconfirmed. The native Terminal may already be open. Check Terminal and Run history before allowing another attempt. Nothing will be resent automatically.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/runs" className="underline">Review Run history</Link>
          <button type="button" className="underline" disabled={Boolean(launching)}
            onClick={acknowledgeUnconfirmed}>I checked Terminal and Run history; allow another attempt</button>
        </div>
      </section>}
      {status?.lastSession && <section className="space-y-2 rounded-md border border-neutral-800 p-3" aria-label="Latest CaseIQ session">
        <div className="flex items-center justify-between gap-2 text-xs">
          <h3 className="font-semibold">Latest CaseIQ session</h3>
          <Link href={`/runs/${status.lastSession.runId}`} className="text-emerald-400 hover:underline">Run details</Link>
        </div>
        <p className="text-xs text-neutral-500">{status.lastSession.status} · {new Date(status.lastSession.createdAt).toLocaleString()}</p>
        {status.lastSession.configuration && <p className="break-words text-xs text-neutral-400">
          Packs: {status.lastSession.configuration.packs.join(", ") || "CaseIQ platform default"} · Case: {status.lastSession.configuration.caseNumber ?? "none"}
        </p>}
        {status.lastSession.reason && <p className="text-xs text-neutral-400">{status.lastSession.reason}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ui-secondary-button"
            disabled={Boolean(launching) || unconfirmed || loading || statusError !== null || disabledReason !== null || status.lastSession.resumeState !== "ready"}
            onClick={resumeSession}>
            <RotateCcw size={13} />{launching === "resume" ? "Resuming CaseIQ..." : "Resume latest CaseIQ Terminal"}
          </button>
          <button type="button" className="ui-secondary-button"
            disabled={Boolean(launching) || !status.lastSession.configuration}
            onClick={reuseConfiguration}>Use last CaseIQ settings</button>
        </div>
        <p className="text-xs text-neutral-500">Reusing settings does not resume or launch a session, and never enables automatic Prompt delivery.</p>
      </section>}
      <label className="block text-xs text-neutral-400">Find a support pack
        <input type="search" aria-label="Filter CaseIQ support packs" className="ui-input mt-1 w-full" value={packQuery}
          onChange={(event) => setPackQuery(event.target.value)} disabled={Boolean(launching)} placeholder="Search pack name or ID" />
      </label>
      <form onSubmit={launch} className="space-y-3">
        <label className="block text-xs text-neutral-400">Support packs (optional, up to {CASEIQ_MAX_PACKS})
          <select multiple size={5} aria-label="CaseIQ support packs" className="ui-input mt-1 w-full" value={packs}
            onChange={(event) => {
              const selected = Array.from(event.target.selectedOptions, (option) => option.value);
              if (selected.length > CASEIQ_MAX_PACKS) { setError(`Select at most ${CASEIQ_MAX_PACKS} support packs.`); return; }
              setPacks(selected);
              setError(null);
            }}
            disabled={Boolean(launching)}>
            {packs.filter((id) => !status?.packs.some((pack) => pack.id === id)).map((id) =>
              <option key={id} value={id} disabled>{id} (unavailable)</option>)}
            {visiblePacks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>{packs.length ? `${packs.length}/${CASEIQ_MAX_PACKS} selected` : "No selection loads CaseIQ platform default. Use Ctrl-click for multiple packs."}</span>
          <button type="button" disabled={Boolean(launching) || !packs.length} onClick={() => { setPacks([]); setError(null); }} className="hover:text-neutral-300">Clear packs</button>
        </div>
        {query && <p role="status" className="text-xs text-neutral-500">{matchingPacks.length} matching packs. Selected packs remain visible.</p>}
        {packs.length > 0 && <ul aria-label="Selected CaseIQ support packs" className="flex flex-wrap gap-2">
          {packs.map((id) => {
            const pack = status?.packs.find((item) => item.id === id);
            return <li key={id}><button type="button" className="ui-secondary-button text-xs" disabled={Boolean(launching)}
              aria-label={`Remove CaseIQ support pack ${id}`} onClick={() => { setPacks((current) => current.filter((value) => value !== id)); setError(null); }}>
              {pack?.name ?? `${id} (unavailable)`}<X size={12} aria-hidden="true" />
            </button></li>;
          })}
        </ul>}
        <label className="block text-xs text-neutral-400">Case number (optional)
          <input aria-label="CaseIQ case number" className="ui-input mt-1 w-full" value={caseNumber} maxLength={200}
            onChange={(event) => setCaseNumber(event.target.value)} disabled={Boolean(launching)} placeholder="Enter only an authorized case" />
        </label>
        <label className="flex items-start gap-2 text-xs text-neutral-400">
          <input type="checkbox" checked={sendPrompt} onChange={(event) => setSendPrompt(event.target.checked)} disabled={Boolean(launching)} />
          Send the saved Work Prompt on open. Otherwise, type your request in native Terminal.
        </label>
        <p className="text-xs text-neutral-500">The normal Work CLI/SDK settings and Full access are not inherited. Supply interactive attachments in native Terminal.</p>
        {disabledReason && <p className="text-xs text-neutral-400">{disabledReason}</p>}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        {statusError && <p role="alert" className="text-sm text-red-400">{statusError}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="ui-primary-button" disabled={Boolean(launching) || unconfirmed || activeSession || loading || statusError !== null || !status?.launchable || disabledReason !== null}>
            <Terminal size={14} />{launching === "new" ? "Opening CaseIQ..." : "Open CaseIQ Terminal"}
          </button>
          <button type="button" className="ui-secondary-button" disabled={loading || Boolean(launching)} onClick={() => void refresh()}>
            <RefreshCw size={13} />Retry environment check
          </button>
        </div>
      </form>
    </section>
  );
}
