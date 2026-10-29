"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, Download, LoaderCircle, Radio, Send, TerminalSquare, User, Wrench } from "lucide-react";
import MarkdownResult from "@/components/MarkdownResult";
import LiveRunLog from "@/components/LiveRunLog";
import ManagedRuntimePanel from "@/components/ManagedRuntimePanel";
import { AttachmentDraft, MessageAttachments, useMessageAttachments } from "@/components/WorkMessageAttachments";
import type { WorkAttachment } from "@/lib/work-attachment-types";
import { activityRecords, conversationTimeline, isAuxiliaryEvent, withPendingFollowUp, type ConversationActivity } from "@/lib/conversation-activity";
import type { ConversationEvent, SessionConversationData } from "@/lib/session-conversation";

function eventTime(value: string | null, timeOnly = false): string {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  const date = new Date(value);
  return timeOnly ? date.toLocaleTimeString() : date.toLocaleString();
}

export function ConversationMessage({ event, relatedEvents = [event], workId, pendingRun }: {
  event: ConversationEvent; relatedEvents?: ConversationEvent[]; workId?: string;
  pendingRun?: { id: string; status: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const auxiliary = isAuxiliaryEvent(event);
  if (auxiliary) {
    const latest = relatedEvents[relatedEvents.length - 1];
    return (
      <details className="work-conversation-activity group min-w-0 border-l border-neutral-800 pl-2 text-xs" onToggle={(change) => setExpanded(change.currentTarget.open)}>
        <summary className={`flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 [&::-webkit-details-marker]:hidden ${latest.status === "failed" ? "text-red-400" : "text-neutral-400"}`}>
          {event.role === "tool" ? <Wrench size={13} className="shrink-0" aria-hidden="true" /> : <TerminalSquare size={13} className="shrink-0" aria-hidden="true" />}
          <span className="min-w-0 truncate" title={event.title}>{event.title}</span>
          {latest.status === "running" && <span className="text-[10px]">Started</span>}
          {latest.status === "failed" && <span className="text-[10px] font-semibold">Failed</span>}
          {latest.status === "success" && <Check size={12} className="shrink-0 text-emerald-400" aria-hidden="true" />}
          <time className="ml-auto shrink-0 text-[10px]" dateTime={latest.timestamp ?? undefined} title={eventTime(latest.timestamp)} aria-label={eventTime(latest.timestamp)}>{eventTime(latest.timestamp, true)}</time>
          <ChevronDown size={12} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        {expanded && <div className="space-y-2 pb-2 pt-1">{relatedEvents.map((record) => <div key={record.id} className="space-y-1">
          {record.text && (record.role === "assistant" ? <MarkdownResult content={record.text} compact />
            : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-950/50 p-3 font-mono text-[11px] leading-5 text-neutral-300">{record.text}</pre>)}
          <p className="break-all font-mono text-[10px] text-neutral-400">{record.type}{record.toolCallId ? ` / ${record.toolCallId}` : ""}{record.agentId ? ` / ${record.agentId}` : ""} · {eventTime(record.timestamp)}</p>
        </div>)}</div>}
      </details>
    );
  }
  if (!event.text.trim() && !event.attachments?.length) return null;
  return (
    <article className={`min-w-0 space-y-1 py-1.5 ${event.role === "user" ? "ml-auto w-fit max-w-[95%] rounded-md bg-neutral-800/45 px-3" : "pr-2"}`} aria-label={`${event.title} message`}>
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        {event.role === "user" ? <User size={14} aria-hidden="true" /> : <Bot size={14} className="text-emerald-400" aria-hidden="true" />}
        <span className="font-semibold text-neutral-300">{event.title}</span>
        <time className="ml-auto text-[10px] text-neutral-600" dateTime={event.timestamp ?? undefined}>{eventTime(event.timestamp)}</time>
        {pendingRun && <Link href={`/runs/${pendingRun.id}`} className="font-mono text-[10px]">{pendingRun.status} / {pendingRun.id.slice(0, 8)}</Link>}
      </div>
      <MarkdownResult content={event.text} />
      {workId && event.attachments?.length ? <MessageAttachments workId={workId} files={event.attachments} /> : null}
    </article>
  );
}

export function ConversationActivityGroup({ activity, live }: { activity: ConversationActivity; live: boolean }) {
  const records = activityRecords(activity.events);
  const tools = records.filter((record) => record.events[0].role === "tool");
  const unfinished = records.some((record) => record.events[record.events.length - 1].status === "running");
  const failures = records.filter((record) => record.events.some((event) => event.status === "failed")).length;
  const active = live && !activity.finished && (unfinished || !activity.turnEnded);
  const [manual, setManual] = useState<{ active: boolean; open: boolean } | null>(null);
  const open = manual?.active === active ? manual.open : active;
  const latest = activity.events[activity.events.length - 1];
  const completed = activity.finished || activity.turnEnded ||
    (tools.length > 0 && tools.every((record) => record.events[record.events.length - 1].status === "success"));
  const status = active ? "Running" : failures ? "Failed" : completed && !unfinished ? "Completed" : "Recorded";
  return (
    <details className="work-activity-group min-w-0 text-xs" open={open} onToggle={(change) => {
      if (change.currentTarget.open !== open) setManual({ active, open: change.currentTarget.open });
    }}>
      <summary className={`flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-0.5 hover:bg-neutral-800/50 [&::-webkit-details-marker]:hidden ${failures ? "text-red-400" : "text-neutral-400"}`}>
        {active ? <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" /> : <Wrench size={13} className="shrink-0" aria-hidden="true" />}
        <span className="font-medium">{tools.length ? "Tools & run details" : "Run details"}</span>
        <span className="min-w-0 truncate">{tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"} · ` : ""}{activity.events.length} events · {status}{failures ? ` · ${failures} failed` : ""}</span>
        <time className="ml-auto shrink-0 text-[10px]" dateTime={latest.timestamp ?? undefined} title={eventTime(latest.timestamp)} aria-label={eventTime(latest.timestamp)}>{eventTime(latest.timestamp, true)}</time>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </summary>
      <div className="work-activity-records py-1 pl-2">
        {records.map((record) => <ConversationMessage key={record.id} event={record.events[0]} relatedEvents={record.events} />)}
      </div>
    </details>
  );
}

export function conversationControlCapabilities(
  data: Pick<SessionConversationData, "anchorRunId" | "steeringRunId" | "canSteer" | "canFollowUp"> | null,
  runtimeEngine: "CLI" | "SDK" | null,
  runId: string | null,
  isLive: boolean,
) {
  const current = data !== null && data.anchorRunId === runId;
  return {
    canSteer: Boolean(current && runtimeEngine === "SDK" && isLive && data?.steeringRunId === runId && data.canSteer),
    canFollowUp: Boolean(current && data?.canFollowUp),
  };
}

export default function SessionConversation({ workId, runId, runtimeEngine, initialLog, isLive, historySync, outputFormat, runActions, workHeader, workActions, notices, runError, panels = [], fileBrowser }: {
  workId: string;
  runId: string | null;
  runtimeEngine: "CLI" | "SDK" | null;
  initialLog: string;
  isLive: boolean;
  historySync: boolean;
  outputFormat: "text" | "json";
  runActions?: ReactNode;
  workHeader?: ReactNode;
  workActions?: ReactNode;
  notices?: ReactNode;
  runError?: ReactNode;
  panels?: { id: string; label: string; content: ReactNode }[];
  fileBrowser?: ReactNode;
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
  const attachments = useMessageAttachments(workId);
  const [frozenDraft, setFrozenDraft] = useState(false);
  const attempt = useRef<{
    requestId: string; text: string; fileIds: string; kind: "steer" | "follow-up";
    runId: string; sessionId: string; expectedParentRunId: string | null | undefined; dispatched: boolean;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [steeringUncertain, setSteeringUncertain] = useState<{
    requestId: string; text: string; runId: string; sessionId: string;
  } | null>(null);
  const [steeringRequestState, setSteeringRequestState] = useState<{
    requestId: string; text: string; runId: string; sessionId: string;
  } | null>(null);
  const steeringRequest = useRef<typeof steeringRequestState>(null);
  const [view, setView] = useState<"conversation" | "raw">("conversation");
  const [navigationHeight, setNavigationHeight] = useState(61);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [selectedPanel, setSelectedPanel] = useState("conversation");
  const [wideFiles, setWideFiles] = useState(false);
  const [verticalTabs, setVerticalTabs] = useState(false);
  const panelPrefix = useId();
  const hasWorkspace = Boolean(workHeader);
  const [pending, setPending] = useState<{ runId: string; text: string; afterOffset: number; attachments?: WorkAttachment[] } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const history = useRef(new Map<string, ConversationEvent>());
  const cursor = useRef<string | null>(null);
  const previous = useRef<string | null>(null);
  const session = useRef<string | null>(null);
  const readBusy = useRef(false);
  const promptHash = useRef<string | null>(null);
  const latestRunId = useRef(runId);
  const reload = useRef<() => Promise<void>>(async () => {});
  const { canSteer, canFollowUp } = conversationControlCapabilities(data, runtimeEngine, runId, isLive);

  useEffect(() => {
    if (!hasWorkspace) return;
    const navigation = document.querySelector("body > nav");
    if (!navigation) return;
    const measure = () => {
      setNavigationHeight(Math.ceil(navigation.getBoundingClientRect().height));
      setViewportHeight(window.visualViewport?.height ?? window.innerHeight);
      setWideFiles(window.matchMedia("(min-width: 1280px)").matches);
      setVerticalTabs(window.matchMedia("(min-width: 1024px)").matches);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(navigation);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [hasWorkspace]);

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
        if (page.runs[0] && latestRunId.current !== page.runs[0].id) {
          latestRunId.current = page.runs[0].id;
          if (page.runs[0].id !== runId) router.refresh();
        }
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
      setSelectedPanel("conversation");
      setView("conversation");
      requestAnimationFrame(() => {
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

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    const fileIds = attachments.files.map((file) => file.id).join(",");
    const useSteering = attempt.current?.dispatched ? attempt.current.kind === "steer" : canSteer;
    if ((!text && !attachments.files.length) || sending || (steeringUncertain && steeringUncertain.text !== text) ||
      (steeringRequest.current && steeringRequest.current.text !== text) ||
      (!attempt.current?.dispatched && !useSteering && !canFollowUp)) return;
    setSending(true); setSendError(null);
    try {
      if (!attempt.current || !attempt.current.dispatched && (
        attempt.current.text !== text || attempt.current.fileIds !== fileIds ||
        attempt.current.kind !== (useSteering ? "steer" : "follow-up") ||
        attempt.current.runId !== (data?.steeringRunId ?? "") ||
        attempt.current.sessionId !== (data?.sessionId ?? "")
      )) {
        attempt.current = {
          requestId: window.crypto.randomUUID(), text, fileIds, kind: useSteering ? "steer" : "follow-up",
          runId: data?.steeringRunId ?? "", sessionId: data?.sessionId ?? "",
          expectedParentRunId: data?.continuationParentRunId, dispatched: false,
        };
      }
      const sendAttempt = attempt.current;
      const savedAttachments = await attachments.upload(sendAttempt.requestId);
      const attachmentIds = savedAttachments.map((file) => file.id);
      if (useSteering) {
        const request = steeringRequest.current?.text === text
          ? steeringRequest.current
          : {
              requestId: sendAttempt.requestId,
              text,
              runId: sendAttempt.runId,
              sessionId: sendAttempt.sessionId,
            };
        steeringRequest.current = request;
        setSteeringRequestState(request);
        sendAttempt.dispatched = true;
        setFrozenDraft(true);
        const response = await fetch(`/api/works/${encodeURIComponent(workId)}/steer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: text,
            requestId: request.requestId,
            runId: request.runId,
            sessionId: request.sessionId,
            attachmentIds,
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
            setFrozenDraft(false);
            attempt.current = null;
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
        attachments.clear();
        setFrozenDraft(false); attempt.current = null;
        nearBottom.current = true;
        setNotice("Accepted by the active session. Acceptance does not guarantee the model has applied the instruction yet.");
        window.dispatchEvent(new CustomEvent("workboard:prompt-updated", { detail: { workId } }));
        router.refresh();
        await reload.current();
        return;
      }
      sendAttempt.dispatched = true;
      setFrozenDraft(true);
      const response = await fetch(`/api/works/${encodeURIComponent(workId)}/follow-up`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, expectedParentRunId: sendAttempt.expectedParentRunId, requestId: sendAttempt.requestId, attachmentIds }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.runId !== "string") {
        if (response.status < 500) { sendAttempt.dispatched = false; setFrozenDraft(false); }
        throw new Error(typeof body.error === "string" ? body.error : "Follow Up did not start");
      }
      setPending({ runId: body.runId, text, attachments: savedAttachments, afterOffset: events.at(-1)?.offset ?? -1 });
      setDraft(""); nearBottom.current = true;
      attachments.clear(); setFrozenDraft(false); attempt.current = null;
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

  const acceptedRun = pending ? data?.runs.find((run) => run.id === pending.runId) : null;
  const pendingMessage = pending && !acceptedRun ? pending
    : data?.pendingPrompt ?? (pending && acceptedRun?.status !== "SUCCESS" && data?.runs[0]?.id === pending.runId ? pending : null);
  const pendingRun = pendingMessage ? data?.runs.find((run) => run.id === pendingMessage.runId) : null;
  const timeline = conversationTimeline(withPendingFollowUp(events, pendingMessage ? {
    ...pendingMessage,
    timestamp: pendingRun?.createdAt ?? null,
    afterOffset: "afterOffset" in pendingMessage ? pendingMessage.afterOffset : undefined,
  } : null));
  const latestActivity = timeline.findLast((item) => item.kind === "activity");
  const Toolbar = workHeader ? "header" : "div";
  const tabs = [
    { id: "conversation", label: "Conversation" },
    ...panels,
    ...(fileBrowser && !wideFiles ? [{ id: "files", label: "Files" }] : []),
  ];
  const activePanel = tabs.some((tab) => tab.id === selectedPanel) ? selectedPanel : "conversation";

  return (
    <div id="session-conversation" className={hasWorkspace ? "work-detail-layout min-w-0" : "min-w-0 space-y-2"}
      style={hasWorkspace ? { height: viewportHeight === null ? `calc(100dvh - ${navigationHeight}px - 1rem)` : Math.max(120, viewportHeight - navigationHeight - 16) } : undefined}>
      <Toolbar className={`work-conversation-toolbar flex flex-wrap items-center gap-x-2 gap-y-1${workHeader ? " work-detail-header work-detail-unified-toolbar" : ""}`} style={workHeader ? { top: navigationHeight } : undefined}>
        {workHeader}
        <h2 id="session-conversation-heading" className={workHeader ? "sr-only" : "flex shrink-0 items-center gap-2 text-xs font-bold text-white sm:text-sm"}>
          <Radio size={14} aria-hidden="true" />
          Session conversation
        </h2>
        <div className="flex shrink-0 items-center gap-1" role="tablist" aria-label="Session view">
          {(["conversation", "raw"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={view === tab}
            onClick={() => { setSelectedPanel("conversation"); setView(tab); }} className={`work-toolbar-control min-h-8 rounded-md px-2 py-1 text-xs font-semibold ${view === tab ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:text-neutral-100"}`}>
            {tab === "conversation" ? "Conversation" : "Raw output"}
          </button>)}
        </div>
        {runActions}
        <div className={`${workHeader ? "" : "ml-auto "}flex shrink-0 items-center gap-1 text-[10px] text-neutral-400`}>
          {data?.sessionId && <span className={workHeader ? "sr-only" : "font-mono"} title={data.sessionId}>Session {data.sessionId.slice(0, 8)}</span>}
          {view === "conversation" && data?.hasEarlier && <button type="button" title="Earlier messages" aria-label="Earlier messages" disabled={earlierLoading} onClick={() => { setSelectedPanel("conversation"); void loadEarlier(); }} className="work-toolbar-action">
            {earlierLoading ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />}{workHeader ? "Earlier" : "Earlier messages"}
          </button>}
          {runId && (data?.historyAvailable || readError) && <a href={endpoint({ download: "1" })} title="Download full session history" aria-label="Download full session history" className="work-toolbar-control grid size-8 place-items-center rounded-md hover:bg-neutral-800 hover:text-emerald-400"><Download size={14} aria-hidden="true" /></a>}
          {view === "conversation" && <button type="button" title="Latest messages" aria-label="Latest messages" onClick={() => {
            setSelectedPanel("conversation");
            nearBottom.current = true;
            requestAnimationFrame(() => container.current?.scrollTo({ top: container.current.scrollHeight, behavior: "smooth" }));
          }} className="work-toolbar-control grid size-8 place-items-center rounded-md hover:bg-neutral-800"><ArrowDown size={14} aria-hidden="true" /></button>}
        </div>
        {workActions}
      </Toolbar>
      <div className={hasWorkspace ? `work-workspace-grid${fileBrowser ? " has-files" : ""}` : ""}>
        {hasWorkspace && <div className="work-section-tabs" role="tablist" aria-label="Work sections" aria-orientation={verticalTabs ? "vertical" : "horizontal"}
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = tabs.findIndex((tab) => tab.id === activePanel);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
              : (index + (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length;
            setSelectedPanel(tabs[next].id);
            document.getElementById(`${panelPrefix}-tab-${tabs[next].id}`)?.focus();
          }}>
          {tabs.map((tab) => <button key={tab.id} type="button" role="tab" id={`${panelPrefix}-tab-${tab.id}`}
            aria-selected={activePanel === tab.id} aria-controls={`${panelPrefix}-panel-${tab.id}`} tabIndex={activePanel === tab.id ? 0 : -1}
            onClick={() => setSelectedPanel(tab.id)} className={`work-section-tab ${activePanel === tab.id ? "is-active" : ""}`}>
            {tab.label}
          </button>)}
        </div>}
        <section id={`${panelPrefix}-panel-conversation`} role={hasWorkspace ? "tabpanel" : undefined}
          aria-labelledby={hasWorkspace ? `${panelPrefix}-tab-conversation` : "session-conversation-heading"}
          hidden={activePanel !== "conversation"} className={hasWorkspace ? "work-conversation-panel" : "space-y-2"}>
          {notices}
          {isLive && runId && runtimeEngine === "SDK" && <ManagedRuntimePanel key={runId} workId={workId} runId={runId} />}
          {notice && <p role="status" className="text-xs text-neutral-500">{notice}</p>}
          {readError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-400">{readError}<button type="button" onClick={() => void reload.current()} className="ui-secondary-button">Retry</button></div>}
          {view === "raw" ? <div className="work-raw-output">{runId
            ? <LiveRunLog key={runId} runId={runId} initialLog={initialLog} isLive={isLive} historySync={historySync} outputFormat={outputFormat} refreshOnStatusChange={false} />
            : <p className="py-4 text-sm text-neutral-500">No Run output yet.</p>}</div>
          : <div ref={container} className="work-conversation-log max-h-[65dvh] min-h-48 overflow-y-auto overscroll-contain pr-2"
            role="log" aria-label="Session conversation" aria-busy={loading}
            onScroll={(change) => { const element = change.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
            {loading && <p className="flex items-center gap-2 py-6 text-sm text-neutral-500"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />Loading conversation...</p>}
            {!loading && timeline.length === 0 && <p className="py-6 text-sm text-neutral-500">{data?.historyUnavailableReason ?? "Waiting for recorded messages..."}</p>}
            {timeline.map((item) => item.kind === "activity"
              ? <ConversationActivityGroup key={item.id} activity={item} live={isLive && item.id === latestActivity?.id} />
              : <ConversationMessage key={item.event.id} event={item.event} workId={workId}
                pendingRun={item.event.type === "work.follow_up" && pendingMessage
                  ? { id: pendingMessage.runId, status: pendingRun?.status ?? "PENDING" } : undefined} />)}
          </div>}
          {data?.incompleteTail && <p role="status" className="text-xs text-neutral-500">Waiting for the current event to finish writing.</p>}
          {runError}
          <form onSubmit={(event) => void send(event)} className="work-conversation-composer border-t border-neutral-800 pt-2"
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              if (!sending && !frozenDraft) attachments.add([...event.dataTransfer.files]);
            }}>
            <label htmlFor="session-follow-up" className="mb-1 block text-xs font-semibold text-neutral-300">
              {steeringRequestState ? "Steering status / repair" : canSteer ? "Steer now" : "Follow Up"}
            </label>
            <textarea id="session-follow-up" ref={textarea} value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={100000}
              placeholder={canSteer ? "Redirect the active task..." : runtimeEngine === "CLI" && isLive && !canFollowUp
                ? "Draft a follow-up to send after this Run finishes..." : "Continue this conversation..."} disabled={sending || frozenDraft}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (!files.length) return;
                event.preventDefault();
                attachments.add(files);
                const pastedText = event.clipboardData.getData("text/plain");
                if (pastedText) {
                  const { selectionStart, selectionEnd } = event.currentTarget;
                  setDraft((value) => value.slice(0, selectionStart) + pastedText + value.slice(selectionEnd));
                }
              }}
              onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void send(); } }}
              className="ui-input min-h-14 w-full resize-y px-3 py-2 text-sm leading-5" />
            <AttachmentDraft {...attachments} disabled={sending || frozenDraft} />
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 flex-1 text-xs text-neutral-500" role="status">
                {steeringUncertain
                  ? "Acceptance is uncertain. Retry only with this exact draft and request ID, or explicitly dismiss it after checking session history."
                  : canSteer
                    ? "Adds an instruction to this active Run/session; it does not undo work or guarantee that a running tool stops."
                    : canFollowUp ? "" : runtimeEngine === "CLI" && isLive
                      ? "Native CLI is running without live Steering or SDK controls. You can edit a draft and send Follow Up after the Run finishes."
                      : data?.blockedReason ?? data?.steeringBlockedReason ?? (data?.terminalActive ? "Session open in Terminal" : "")}
              </p>
              <button type="submit" disabled={sending || (!draft.trim() && !attachments.files.length) ||
                (steeringUncertain !== null && steeringUncertain.text !== draft.trim()) ||
                (steeringRequestState !== null && steeringRequestState.text !== draft.trim()) ||
                (!frozenDraft && !steeringRequestState && !canFollowUp && !canSteer) || readError !== null} className="ui-primary-button">
                {sending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                {steeringRequestState ? "Retry / repair Steering" : frozenDraft ? "Retry Follow Up" : canSteer ? "Steer now" : "Send Follow Up"}
              </button>
            </div>
            {sendError && <p role="alert" className="mt-2 text-sm text-red-400">{sendError}</p>}
            {frozenDraft && !steeringUncertain && !steeringRequestState && <p role="status" className="mt-1 text-xs text-neutral-400">
              This draft is frozen until delivery is resolved. Retry uses the same message and attachment IDs.
            </p>}
            {steeringUncertain && <button type="button" className="mt-2 text-xs text-amber-400 underline"
              onClick={() => {
                setSteeringUncertain(null);
                steeringRequest.current = null;
                setSteeringRequestState(null);
                setDraft("");
                attachments.clear(); setFrozenDraft(false); attempt.current = null;
                setSendError(null);
              }}>
              Dismiss this uncertain draft after checking session history
            </button>}
          </form>
        </section>
        {panels.map((panel) => <section key={panel.id} id={`${panelPrefix}-panel-${panel.id}`} role="tabpanel"
          aria-labelledby={`${panelPrefix}-tab-${panel.id}`} hidden={activePanel !== panel.id} tabIndex={0} className="work-secondary-panel">
          {panel.content}
        </section>)}
        {fileBrowser && <aside id={`${panelPrefix}-panel-files`} aria-label="Work files" role={wideFiles ? undefined : "tabpanel"}
          aria-labelledby={wideFiles ? undefined : `${panelPrefix}-tab-files`}
          hidden={!wideFiles && activePanel !== "files"} className="work-files-panel">
          {fileBrowser}
        </aside>}
      </div>
    </div>
  );
}