"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, Download, LoaderCircle, Send, TerminalSquare, User, Wrench } from "lucide-react";
import MarkdownResult from "@/components/MarkdownResult";
import LiveRunLog from "@/components/LiveRunLog";
import type { ConversationEvent, SessionConversationData } from "@/lib/session-conversation";

function eventTime(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Date(value).toLocaleString();
}

export function ConversationMessage({ event }: { event: ConversationEvent }) {
  const [expanded, setExpanded] = useState(false);
  const auxiliary = event.role === "tool" || event.role === "system" || event.agentId !== null;
  if (auxiliary) {
    return (
      <details className="group border-l-2 border-neutral-800 pl-3 text-xs" onToggle={(change) => setExpanded(change.currentTarget.open)}>
        <summary className={`flex cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden ${event.status === "failed" ? "text-red-400" : "text-neutral-500"}`}>
          {event.role === "tool" ? <Wrench size={13} className="shrink-0" aria-hidden="true" /> : <TerminalSquare size={13} className="shrink-0" aria-hidden="true" />}
          <span className="min-w-0 break-words">{event.title}</span>
          {event.status === "running" && <span className="text-[10px] text-neutral-600">Started</span>}
          {event.status === "success" && <Check size={12} className="shrink-0 text-emerald-400" aria-hidden="true" />}
          <time className="ml-auto shrink-0 text-[10px] text-neutral-600" dateTime={event.timestamp ?? undefined}>{eventTime(event.timestamp)}</time>
          <ChevronDown size={12} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        {expanded && <div className="space-y-2 pb-3">
          {event.text && (event.role === "assistant" ? <MarkdownResult content={event.text} compact />
            : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-950/50 p-3 font-mono text-[11px] leading-5 text-neutral-300">{event.text}</pre>)}
          <p className="break-all font-mono text-[10px] text-neutral-600">{event.type}{event.toolCallId ? ` / ${event.toolCallId}` : ""}{event.agentId ? ` / ${event.agentId}` : ""}</p>
        </div>}
      </details>
    );
  }
  return (
    <article className={`min-w-0 space-y-2 py-3 ${event.role === "user" ? "ml-auto w-fit max-w-[95%] rounded-md bg-neutral-800/45 px-4" : "pr-2"}`} aria-label={`${event.title} message`}>
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        {event.role === "user" ? <User size={14} aria-hidden="true" /> : <Bot size={14} className="text-emerald-400" aria-hidden="true" />}
        <span className="font-semibold text-neutral-300">{event.title}</span>
        <time className="ml-auto text-[10px] text-neutral-600" dateTime={event.timestamp ?? undefined}>{eventTime(event.timestamp)}</time>
      </div>
      <MarkdownResult content={event.text} />
    </article>
  );
}

export default function SessionConversation({ workId, runId, initialLog, isLive, historySync, outputFormat }: {
  workId: string;
  runId: string | null;
  initialLog: string;
  isLive: boolean;
  historySync: boolean;
  outputFormat: "text" | "json";
}) {
  const router = useRouter();
  const [data, setData] = useState<SessionConversationData | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [steeringUncertain, setSteeringUncertain] = useState<{
    requestId: string; text: string; runId: string; sessionId: string;
  } | null>(null);
  const [steeringRequestState, setSteeringRequestState] = useState<{
    requestId: string; text: string; runId: string; sessionId: string;
  } | null>(null);
  const steeringRequest = useRef<typeof steeringRequestState>(null);
  const [view, setView] = useState<"conversation" | "raw">("conversation");
  const [pending, setPending] = useState<{ runId: string; text: string; afterOffset: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const history = useRef(new Map<string, ConversationEvent>());
  const cursor = useRef<string | null>(null);
  const previous = useRef<string | null>(null);
  const session = useRef<string | null>(null);
  const readBusy = useRef(false);
  const promptHash = useRef<string | null>(null);
  const runRevision = useRef<string | null>(null);
  const reload = useRef<() => Promise<void>>(async () => {});

  function endpoint(extra?: { cursor?: string; before?: string; download?: string }) {
    const query = new URLSearchParams({ ...(runId ? { runId } : {}), ...extra });
    return `/api/works/${encodeURIComponent(workId)}/conversation?${query}`;
  }

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const url = (nextCursor: string | null) => {
      const query = new URLSearchParams({ ...(runId ? { runId } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) });
      return `/api/works/${encodeURIComponent(workId)}/conversation?${query}`;
    };
    async function load(retryReset = true) {
      if (stopped || readBusy.current || document.hidden) return;
      readBusy.current = true;
      let again = false;
      try {
        const response = await fetch(url(cursor.current), { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (stopped) return;
        if (!response.ok) {
          if (retryReset && (body.reset === true || response.status === 400 && cursor.current !== null)) {
            history.current.clear(); cursor.current = null; previous.current = null;
            setNotice("The stored session changed. Its conversation is being reloaded.");
            again = true;
            return;
          }
          throw new Error(typeof body.error === "string" ? body.error : "Unable to load conversation");
        }
        const page = body as SessionConversationData;
        if (session.current !== null && session.current !== page.sessionId) {
          history.current.clear(); cursor.current = null; previous.current = null;
          session.current = page.sessionId;
          setEvents([]);
          setNotice("A different session is now selected. Your draft has been kept.");
          again = true;
          return;
        }
        const firstPage = cursor.current === null;
        session.current = page.sessionId;
        let changed = false;
        for (const event of page.events) {
          if (!history.current.has(event.id)) { history.current.set(event.id, event); changed = true; }
        }
        if (changed || firstPage) setEvents([...history.current.values()].sort((left, right) => left.offset - right.offset));
        cursor.current = page.nextCursor;
        if (firstPage) previous.current = page.previousCursor;
        setData({ ...page, previousCursor: previous.current, hasEarlier: previous.current !== null });
        setLoading(false);
        setReadError(null);
        if (promptHash.current !== null && promptHash.current !== page.promptHash) {
          window.dispatchEvent(new CustomEvent("workboard:prompt-updated", { detail: { workId } }));
        }
        promptHash.current = page.promptHash;
        const revision = page.runs[0] ? `${page.runs[0].id}:${page.runs[0].status}` : "empty";
        if (runRevision.current !== null && runRevision.current !== revision) router.refresh();
        runRevision.current = revision;
        again = page.hasMore;
      } catch (error) {
        if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) {
          setReadError(error instanceof Error ? error.message : "Unable to load conversation");
          setLoading(false);
        }
      } finally {
        readBusy.current = false;
        if (again && !stopped) void load(false);
      }
    }
    reload.current = () => load();
    const refresh = () => { void load(); };
    void load();
    const timer = setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true; controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workId, runId, router]);

  useEffect(() => {
    if (nearBottom.current && container.current) container.current.scrollTop = container.current.scrollHeight;
  }, [events, pending]);

  useEffect(() => {
    const focusComposer = (event: Event) => {
      if ((event as CustomEvent<{ workId: string }>).detail?.workId !== workId) return;
      setView("conversation");
      requestAnimationFrame(() => {
        textarea.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        textarea.current?.focus({ preventScroll: true });
      });
    };
    window.addEventListener("workboard:follow-up-focus", focusComposer);
    return () => window.removeEventListener("workboard:follow-up-focus", focusComposer);
  }, [workId]);

  async function loadEarlier() {
    if (!previous.current || readBusy.current) return;
    readBusy.current = true;
    setEarlierLoading(true);
    const oldHeight = container.current?.scrollHeight ?? 0;
    const oldTop = container.current?.scrollTop ?? 0;
    nearBottom.current = false;
    try {
      const response = await fetch(endpoint({ before: previous.current }), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to load earlier messages");
      const page = body as SessionConversationData;
      page.events.forEach((event) => history.current.set(event.id, event));
      previous.current = page.previousCursor;
      setEvents([...history.current.values()].sort((left, right) => left.offset - right.offset));
      setData((current) => current ? { ...current, previousCursor: page.previousCursor, hasEarlier: page.hasEarlier } : page);
      requestAnimationFrame(() => {
        if (container.current) container.current.scrollTop = oldTop + container.current.scrollHeight - oldHeight;
      });
    } catch (error) { setReadError(error instanceof Error ? error.message : "Unable to load earlier messages"); }
    finally { readBusy.current = false; setEarlierLoading(false); }
  }

  async function repairSteeringMessage(message: SessionConversationData["steeringMessages"][number]) {
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(`/api/works/${encodeURIComponent(workId)}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: message.content,
          requestId: message.requestId,
          runId: message.runId,
          sessionId: data?.sessionId ?? "",
        }),
      });
      const body = await response.json();
      if (!response.ok || body.transportAccepted !== true) {
        throw new Error(typeof body.error === "string" ? body.error : "Steering record repair failed");
      }
      if (body.promptSynced !== true || body.artifactSynced !== true) {
        throw new Error(typeof body.notice === "string" ? body.notice : "Local Steering records still need repair.");
      }
      window.dispatchEvent(new CustomEvent("workboard:prompt-updated", { detail: { workId } }));
      setNotice("Accepted Steering records repaired without resending the instruction.");
      await reload.current();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Unable to repair Steering records");
    } finally {
      setSending(false);
    }
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    const useSteering = steeringRequest.current !== null || data?.canSteer === true;
    if (!text || sending || (steeringUncertain && steeringUncertain.text !== text) ||
      (steeringRequest.current && steeringRequest.current.text !== text) ||
      (!useSteering && !data?.canFollowUp)) return;
    setSending(true); setSendError(null);
    try {
      if (useSteering) {
        const request = steeringRequest.current?.text === text
          ? steeringRequest.current
          : {
              requestId: window.crypto.randomUUID(),
              text,
              runId: data?.steeringRunId ?? "",
              sessionId: data?.sessionId ?? "",
            };
        steeringRequest.current = request;
        setSteeringRequestState(request);
        const response = await fetch(`/api/works/${encodeURIComponent(workId)}/steer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: text,
            requestId: request.requestId,
            runId: request.runId,
            sessionId: request.sessionId,
          }),
        });
        const body = await response.json();
        if (!response.ok) {
          if (body.deliveryState === "UNCERTAIN") {
            setSteeringUncertain(request);
            throw new Error(`${body.error} Retrying this same request will not resend it.`);
          }
          if (body.deliveryState === "REJECTED") {
            steeringRequest.current = null;
            setSteeringRequestState(null);
            setSteeringUncertain(null);
          }
          throw new Error(typeof body.error === "string" ? body.error : "Steering was not accepted");
        }
        if (body.transportAccepted !== true) throw new Error("The session did not confirm Steering acceptance.");
        if (body.promptSynced !== true || body.artifactSynced !== true) {
          setSendError(typeof body.notice === "string"
            ? body.notice
            : "Accepted by the session, but local records need repair. Retry this same request; it will not be resent.");
          return;
        }
        steeringRequest.current = null;
        setSteeringRequestState(null);
        setSteeringUncertain(null);
        setDraft("");
        nearBottom.current = true;
        setNotice("Accepted by the active session. Acceptance does not guarantee the model has applied the instruction yet.");
        window.dispatchEvent(new CustomEvent("workboard:prompt-updated", { detail: { workId } }));
        router.refresh();
        await reload.current();
        return;
      }
      const response = await fetch(`/api/works/${encodeURIComponent(workId)}/follow-up`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, expectedParentRunId: data?.continuationParentRunId }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.runId !== "string") throw new Error(typeof body.error === "string" ? body.error : "Follow Up did not start");
      setPending({ runId: body.runId, text, afterOffset: events.at(-1)?.offset ?? -1 });
      setDraft(""); nearBottom.current = true;
      window.dispatchEvent(new CustomEvent("workboard:prompt-updated", { detail: { workId } }));
      router.refresh();
      await reload.current();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to send";
      if (useSteering && steeringRequest.current?.text === text) {
        setSteeringUncertain((current) => current ?? steeringRequest.current);
        setSendError(`Steering status may be unknown. Keep this draft and retry with the same request ID; do not submit a new instruction. ${message}`);
      } else {
        setSendError(message);
      }
    }
    finally { setSending(false); }
  }

  const acceptedStatus = pending ? data?.runs.find((run) => run.id === pending.runId)?.status : null;
  const pendingMessage = pending && acceptedStatus !== "SUCCESS" && !events.some((event) => event.offset > pending.afterOffset && event.role === "user" && event.text.includes(pending.text))
    ? pending : data?.pendingPrompt && !events.some((event) => event.role === "user" && event.text.trim() === data.pendingPrompt?.text.trim())
      ? { runId: data.pendingPrompt.runId, text: data.pendingPrompt.text, afterOffset: -1 } : null;
  const pendingStatus = pendingMessage ? data?.runs.find((run) => run.id === pendingMessage.runId)?.status : null;

  return (
    <div id="session-conversation" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="Session view">
          {(["conversation", "raw"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={view === tab}
            onClick={() => setView(tab)} className={`rounded-md px-3 py-2 text-xs font-semibold ${view === tab ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}>
            {tab === "conversation" ? "Conversation" : "Raw output"}
          </button>)}
        </div>
        <div className="flex min-w-0 items-center gap-3 text-[10px] text-neutral-500">
          {data?.sessionId && <span className="font-mono" title={data.sessionId}>Session {data.sessionId.slice(0, 8)}</span>}
          {runId && (data?.historyAvailable || readError) && <a href={endpoint({ download: "1" })} title="Download full session history" aria-label="Download full session history" className="grid size-8 place-items-center rounded-md hover:bg-neutral-800 hover:text-emerald-400"><Download size={14} aria-hidden="true" /></a>}
        </div>
      </div>
      {view === "raw" ? runId ? <LiveRunLog key={runId} runId={runId} initialLog={initialLog} isLive={isLive} historySync={historySync} outputFormat={outputFormat} />
        : <p className="py-4 text-sm text-neutral-500">No Run output yet.</p>
        : <>
          {notice && <p role="status" className="text-xs text-neutral-500">{notice}</p>}
          {readError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-400">{readError}<button type="button" onClick={() => void reload.current()} className="ui-secondary-button">Retry</button></div>}
          {data?.hasEarlier && <button type="button" disabled={earlierLoading} onClick={() => void loadEarlier()} className="ui-secondary-button min-h-8 text-xs">
            {earlierLoading ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />}Earlier messages
          </button>}
          <div ref={container} className="max-h-[65dvh] min-h-48 space-y-3 overflow-y-auto overscroll-contain pr-2"
            role="log" aria-label="Session conversation" aria-busy={loading}
            onScroll={(change) => { const element = change.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
            {loading && <p className="flex items-center gap-2 py-6 text-sm text-neutral-500"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />Loading conversation...</p>}
            {!loading && events.length === 0 && <p className="py-6 text-sm text-neutral-500">{data?.historyUnavailableReason ?? "Waiting for recorded messages..."}</p>}
            {events.map((event) => <ConversationMessage key={event.id} event={event} />)}
            {pendingMessage && <article className="ml-auto max-w-[95%] space-y-2 rounded-md bg-neutral-800/45 p-4" aria-label="Pending follow up">
              <div className="flex items-center gap-2 text-xs text-neutral-500"><User size={14} aria-hidden="true" />You<Link href={`/runs/${pendingMessage.runId}`} className="ml-auto font-mono text-[10px]">{pendingStatus ?? "PENDING"} / {pendingMessage.runId.slice(0, 8)}</Link></div>
              <MarkdownResult content={pendingMessage.text} />
            </article>}
          </div>
          <div className="flex justify-end"><button type="button" title="Latest messages" aria-label="Latest messages" onClick={() => { nearBottom.current = true; container.current?.scrollTo({ top: container.current.scrollHeight, behavior: "smooth" }); }} className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800"><ArrowDown size={14} aria-hidden="true" /></button></div>
          {data?.incompleteTail && <p role="status" className="text-xs text-neutral-500">Waiting for the current event to finish writing.</p>}
          {data?.runs && data.runs.length > 1 && <details className="text-xs text-neutral-500"><summary className="cursor-pointer">{data.runs.length} Runs in this session</summary><div className="mt-2 flex flex-wrap gap-2">{data.runs.map((run) => <Link key={run.id} href={`/runs/${run.id}`} className="border-b border-neutral-700 py-1 font-mono">{run.id.slice(0, 8)} / {run.status}</Link>)}</div></details>}
          {data?.steeringMessages.length ? <details className="text-xs text-neutral-500">
            <summary className="cursor-pointer">Steering delivery audit ({data.steeringMessages.length})</summary>
            <div className="mt-2 space-y-3">
              {data.steeringMessages.map((message) => <div key={message.id} className="rounded-md border border-neutral-800 p-3">
                <p className="mb-2 text-[10px] uppercase tracking-wide text-neutral-500">
                  {message.deliveryState} · Prompt {message.promptSynced ? "updated" : "needs repair"} · Run audit {message.artifactSynced ? "saved" : "needs repair"}
                </p>
                {message.deliveryState === "UNCERTAIN" &&
                  <p className="mb-2 text-xs text-amber-400">The instruction may have reached the session. It was not replayed; inspect the full session history before creating another instruction.</p>}
                <MarkdownResult content={message.content} compact />
                {(message.promptError || message.artifactError) && <p className="mt-2 text-[10px] text-amber-400">{message.promptError ?? message.artifactError}</p>}
                {["ACCEPTED", "OBSERVED"].includes(message.deliveryState) &&
                  (!message.promptSynced || !message.artifactSynced) &&
                  <button type="button" disabled={sending} className="mt-2 text-xs text-emerald-400 underline"
                    onClick={() => void repairSteeringMessage(message)}>
                    Repair local records (does not resend)
                  </button>}
              </div>)}
            </div>
          </details> : null}
          <form onSubmit={(event) => void send(event)} className="border-t border-neutral-800 pt-3">
            <label htmlFor="session-follow-up" className="mb-2 block text-xs font-semibold text-neutral-300">
              {steeringRequestState ? "Steering status / repair" : data?.canSteer ? "Steer now" : "Follow Up"}
            </label>
            <textarea id="session-follow-up" ref={textarea} value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} maxLength={100000}
              placeholder={data?.canSteer ? "Redirect the active task..." : "Continue this conversation..."} disabled={sending}
              onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void send(); } }}
              className="ui-input min-h-24 w-full resize-y px-3 py-3 text-sm leading-6" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-xs text-neutral-500" role="status">
                {steeringUncertain
                  ? "Acceptance is uncertain. Retry only with this exact draft and request ID, or explicitly dismiss it after checking session history."
                  : data?.canSteer
                    ? "Adds an instruction to this active Run/session; it does not undo work or guarantee that a running tool stops."
                    : data?.blockedReason ?? data?.steeringBlockedReason ?? (data?.terminalActive ? "Session open in Terminal" : "")}
              </p>
              <button type="submit" disabled={sending || !draft.trim() ||
                (steeringUncertain !== null && steeringUncertain.text !== draft.trim()) ||
                (steeringRequestState !== null && steeringRequestState.text !== draft.trim()) ||
                (!steeringRequestState && !data?.canFollowUp && !data?.canSteer) || readError !== null} className="ui-primary-button">
                {sending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                {steeringRequestState ? "Retry / repair Steering" : data?.canSteer ? "Steer now" : "Send Follow Up"}
              </button>
            </div>
            {sendError && <p role="alert" className="mt-2 text-sm text-red-400">{sendError}</p>}
            {steeringUncertain && <button type="button" className="mt-2 text-xs text-amber-400 underline"
              onClick={() => {
                setSteeringUncertain(null);
                steeringRequest.current = null;
                setSteeringRequestState(null);
                setDraft("");
                setSendError(null);
              }}>
              Dismiss this uncertain draft after checking session history
            </button>}
          </form>
        </>}
    </div>
  );
}