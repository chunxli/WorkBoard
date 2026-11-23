"use client";

import Link from "next/link";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, Bot, Check, ChevronDown, Download, ListPlus, LoaderCircle, Radio, Send, TerminalSquare, User, Wrench } from "lucide-react";
import MarkdownResult from "@/components/MarkdownResult";
import CopyableCodeBlock from "@/components/CopyableCodeBlock";
import { FollowUpComposerContext } from "@/components/FollowUpComposerContext";
import { WorkFileNavigationContext, useWorkFileLocations } from "@/components/WorkFileNavigationContext";
import { insertPromptName, restorePromptSelection, type PromptSelection } from "@/lib/prompt-insertion";
import LiveRunLog from "@/components/LiveRunLog";
import SessionUsagePanel from "@/components/SessionUsagePanel";
import WorkWorkspace from "@/components/WorkWorkspace";
import ManagedRuntimePanel from "@/components/ManagedRuntimePanel";
import CaseIqStartupStatus from "@/components/CaseIqStartupStatus";
import { CaseIqAuthenticationPanel, CaseIqSignInCallout, useCaseIqAuthentication } from "@/components/CaseIqAuthenticationPanel";
import { CaseIqToolPermissionsPanel, useCaseIqToolPermissions } from "@/components/CaseIqToolPermissionsPanel";
import { isCaseIqAuthenticationCommand } from "@/lib/caseiq-options";
import { AttachmentDraft, MessageAttachments, useMessageAttachments } from "@/components/WorkMessageAttachments";
import type { WorkAttachment } from "@/lib/work-attachment-types";
import { conversationTimeline, conversationTimelineRows, conversationToolActivityAt, isAuxiliaryEvent, isConversationMessage, withPendingFollowUp, type ConversationActivitySummary, type ConversationTimelineItem } from "@/lib/conversation-activity";
import type { ConversationEvent, SessionConversationData } from "@/lib/session-conversation";
import { ConversationPinsContext, ConversationPinsPanel, ConversationPinsProvider } from "@/components/ConversationPins";
import ConversationMarkdown from "@/components/ConversationMarkdown";
import type { ConversationPin } from "@/lib/conversation-pin-types";
import PairedSessionPanels, {
  PairedFollowUpReceipt, PairedFollowUpTargets, PairedLaneToolbar, pairedViewLanes, readPairedSessionView, type PairedLaneControl,
  type PairedResultFilesAction, type PairedSessionView,
} from "@/components/PairedSessionPanels";
import { pairedLaneInfo, readPairedFollowUpReceipt, type PairedWorkFollowUp, type PairedWorkLane, type PairedWorkReceipt } from "@/lib/work-session-pair";

type LaneDisplay = {
  sessionId: string;
  runId: string | null;
  isLive: boolean;
  awaitingRunStart: boolean;
  initialLog: string;
  outputFormat: "text" | "json";
  notices?: ReactNode;
  runActions?: ReactNode;
  runError?: ReactNode;
};
type PairedAttempt = Omit<PairedWorkFollowUp, "attachmentIds"> & { attachmentIds?: string[]; draftFileIds: string };

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
  const pinContext = useContext(ConversationPinsContext);
  const pinnedOpen = relatedEvents.some((record) => record.id === pinContext?.activePin?.eventId);
  const auxiliary = isAuxiliaryEvent(event);
  if (auxiliary) {
    const latest = relatedEvents[relatedEvents.length - 1];
    return (
      <details open={pinnedOpen || undefined} className="work-conversation-activity group min-w-0 border-l border-neutral-800 pl-2 text-xs" onToggle={(change) => setExpanded(change.currentTarget.open)}>
        <summary className={`flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 [&::-webkit-details-marker]:hidden ${latest.status === "failed" ? "text-red-400" : "text-neutral-400"}`}>
          {event.role === "tool" ? <Wrench size={13} className="shrink-0" aria-hidden="true" /> : <TerminalSquare size={13} className="shrink-0" aria-hidden="true" />}
          <span className="min-w-0 truncate" title={event.title}>{event.title}</span>
          {latest.status === "running" && <span className="text-[10px]">Started</span>}
          {latest.status === "failed" && <span className="text-[10px] font-semibold">Failed</span>}
          {latest.status === "success" && <Check size={12} className="shrink-0 text-emerald-400" aria-hidden="true" />}
          <time className="ml-auto shrink-0 text-[10px]" dateTime={latest.timestamp ?? undefined} title={eventTime(latest.timestamp)} aria-label={eventTime(latest.timestamp)}>{eventTime(latest.timestamp, true)}</time>
          <ChevronDown size={12} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        {(expanded || pinnedOpen) && <div className="space-y-2 pb-2 pt-1">{relatedEvents.map((record) => <div key={record.id} className="space-y-1">
          {record.text && (record.role === "assistant" ? <ConversationMarkdown event={record} compact />
            : <CopyableCodeBlock className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-950/50 p-3 font-mono text-[11px] leading-5 text-neutral-300"><code>{record.text}</code></CopyableCodeBlock>)}
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
      {event.role === "assistant" ? <ConversationMarkdown event={event} /> : <MarkdownResult content={event.text} copyCodeBlocks />}
      {workId && event.attachments?.length ? <MessageAttachments workId={workId} files={event.attachments} /> : null}
    </article>
  );
}

function ConversationActivityGroup({ activity }: { activity: ConversationActivitySummary }) {
  const { records, toolCount, eventCount, failures, status, timestamp } = activity;
  const active = status === "Running";
  const [manual, setManual] = useState<{ active: boolean; open: boolean } | null>(null);
  const pinContext = useContext(ConversationPinsContext);
  const pinnedEventId = pinContext?.activePin?.eventId;
  const pinnedOpen = Boolean(pinnedEventId) && records.some((record) => record.events.some((event) => event.id === pinnedEventId));
  const open = pinnedOpen || (manual?.active === active ? manual.open : active);
  return (
    <details className="work-activity-group min-w-0 text-xs" open={open} onToggle={(change) => {
      if (change.currentTarget.open !== open) setManual({ active, open: change.currentTarget.open });
    }}>
      <summary className={`flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-0.5 hover:bg-neutral-800/50 [&::-webkit-details-marker]:hidden ${failures ? "text-red-400" : "text-neutral-400"}`}>
        {active ? <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" /> : <Wrench size={13} className="shrink-0" aria-hidden="true" />}
        <span className="font-medium">{toolCount ? "Tools & run details" : "Run details"}</span>
        <span className="min-w-0 truncate">{toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"} · ` : ""}{eventCount} events · {status}{failures ? ` · ${failures} failed` : ""}</span>
        <time className="ml-auto shrink-0 text-[10px]" dateTime={timestamp ?? undefined} title={eventTime(timestamp)} aria-label={eventTime(timestamp)}>{eventTime(timestamp, true)}</time>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </summary>
      <div className="work-activity-records py-1 pl-2">
        {records.map((record) => <ConversationMessage key={record.id} event={record.events[0]} relatedEvents={record.events} />)}
      </div>
    </details>
  );
}

export function conversationControlCapabilities(
  data: Pick<SessionConversationData, "anchorRunId" | "steeringRunId" | "canSteer" | "canFollowUp" | "canQueue"> | null,
  runtimeEngine: "CLI" | "SDK" | "CASEIQ" | null,
  runId: string | null,
  isLive: boolean,
) {
  const current = data !== null && data.anchorRunId === runId;
  return {
    canSteer: Boolean(current && runtimeEngine === "SDK" && isLive && data?.steeringRunId === runId && data.canSteer),
    canFollowUp: Boolean(current && data?.canFollowUp),
    canQueue: Boolean(current && isLive && data?.canQueue),
  };
}

export function handleConversationComposerKeyDown(
  event: {
    key: string;
    shiftKey: boolean;
    repeat: boolean;
    nativeEvent: Pick<KeyboardEvent, "isComposing" | "keyCode">;
    preventDefault(): void;
  },
  submit: () => void,
) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) submit();
}

export function handleConversationHistoryWheel(
  event: {
    deltaY: number;
    ctrlKey: boolean;
    currentTarget: EventTarget & Pick<HTMLDivElement, "scrollTop">;
    nativeEvent: Pick<WheelEvent, "composedPath">;
  },
  loadEarlier: () => void,
) {
  if (event.ctrlKey || event.deltaY >= 0 || event.currentTarget.scrollTop > 0) return;
  for (const target of event.nativeEvent.composedPath()) {
    if (target === event.currentTarget) break;
    if (target instanceof HTMLElement && target.scrollTop > 0 && target.scrollHeight > target.clientHeight) return;
  }
  loadEarlier();
}

export async function readEarlierConversationPages<Page extends Pick<SessionConversationData, "events" | "previousCursor">>(
  before: string,
  readPage: (before: string) => Promise<Page>,
  onPage: (page: Page) => void,
  options: { knownIds?: Iterable<string>; signal: AbortSignal },
): Promise<void> {
  const known = new Set(options.knownIds);
  const visited = new Set<string>();
  let cursor: string | null = before;
  while (cursor) {
    options.signal.throwIfAborted();
    if (visited.has(cursor)) throw new Error("Earlier history did not advance. Refresh the conversation.");
    visited.add(cursor);
    const page = await readPage(cursor);
    options.signal.throwIfAborted();
    const foundMessage = page.events.some((event) => !known.has(event.id) && isConversationMessage(event));
    page.events.forEach((event) => known.add(event.id));
    onPage(page);
    if (page.previousCursor && visited.has(page.previousCursor)) {
      throw new Error("Earlier history did not advance. Refresh the conversation.");
    }
    if (foundMessage) return;
    cursor = page.previousCursor;
  }
}

export function ConversationTimelineEntries({ timeline, workId, isLive, pendingRun, startup }: {
  timeline: ConversationTimelineItem[]; workId: string; isLive: boolean;
  pendingRun?: { id: string; status: string }; startup?: ReactNode;
}) {
  return <>
    {conversationTimelineRows(timeline, isLive).map((item) => item.kind === "activity"
      ? <ConversationActivityGroup key={item.id} activity={item} />
      : <ConversationMessage key={item.event.id} event={item.event} workId={workId}
        pendingRun={item.event.type === "work.follow_up" && item.event.id === `follow-up:${pendingRun?.id}`
          ? pendingRun : undefined} />)}
    {startup}
  </>;
}

export default function SessionConversation({ workId, runId, runtimeEngine, initialLog, isLive, awaitingRunStart = false, historySync, outputFormat, runActions, workHeader, workActions, notices, runError, panels = [], fileBrowser,
  paired, lane, visible = true, onLaneControl, onOpenConfiguration, resultFiles }: {
  workId: string;
  runId: string | null;
  runtimeEngine: "CLI" | "SDK" | "CASEIQ" | null;
  initialLog: string;
  isLive: boolean;
  awaitingRunStart?: boolean;
  historySync: boolean;
  outputFormat: "text" | "json";
  runActions?: ReactNode;
  workHeader?: ReactNode;
  workActions?: ReactNode;
  notices?: ReactNode;
  runError?: ReactNode;
  panels?: { id: string; label: string; content: ReactNode }[];
  fileBrowser?: ReactNode;
  paired?: { lanes: Record<PairedWorkLane, LaneDisplay>; sendBlockedReason: string | null };
  lane?: { kind: PairedWorkLane; sessionId: string };
  visible?: boolean;
  onLaneControl?(lane: PairedWorkLane, control: PairedLaneControl): void;
  onOpenConfiguration?(): void;
  resultFiles?: PairedResultFilesAction;
}) {
  const router = useRouter();
  const [data, setData] = useState<SessionConversationData | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [pinWindow, setPinWindow] = useState<SessionConversationData | null>(null);
  const [pinTarget, setPinTarget] = useState<ConversationPin | null>(null);
  const [pinLoading, setPinLoading] = useState(false);
  const pinController = useRef<AbortController | null>(null);
  const earlierController = useRef<AbortController | null>(null);
  const pendingPinJump = useRef<{ pin: ConversationPin; resolve(): void; reject(error: Error): void } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [earlierReadError, setEarlierReadError] = useState<string | null>(null);
  const conversationReadError = readError ?? earlierReadError;
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pairedReceipt, setPairedReceipt] = useState<PairedWorkReceipt | null>(null);
  const [newPairedMessages, setNewPairedMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const draftValue = useRef("");
  const draftSelection = useRef<PromptSelection | null>(null);
  const pendingDraftSelection = useRef<PromptSelection | null>(null);
  const [draftInsertionError, setDraftInsertionError] = useState<string | null>(null);
  const [draftComposing, setDraftComposing] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const attachments = useMessageAttachments(workId);
  const [frozenDraft, setFrozenDraft] = useState(false);
  const [submittedView, setSubmittedView] = useState<PairedSessionView>("both");
  const [laneControls, setLaneControls] = useState<Partial<Record<PairedWorkLane, PairedLaneControl>>>({});
  const pairedAttempt = useRef<PairedAttempt | null>(null);
  const pairSending = useRef(false);
  const recordLaneControl = useCallback((kind: PairedWorkLane, control: PairedLaneControl) => {
    setLaneControls((current) => {
      const previous = current[kind];
      return previous?.parentRunId === control.parentRunId && previous.blockedReason === control.blockedReason &&
        previous.queued === control.queued ? current : { ...current, [kind]: control };
    });
  }, []);
  const attempt = useRef<{
    requestId: string; text: string; fileIds: string; kind: "steer" | "follow-up" | "queue";
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
  const [localPanel, setLocalPanel] = useState("conversation");
  const [wideFiles, setWideFiles] = useState(false);
  const [verticalTabs, setVerticalTabs] = useState(false);
  const fileLocations = useWorkFileLocations();
  const filesPanel = useRef<HTMLElement>(null);
  const resultFilesOpener = useRef<HTMLButtonElement | null>(null);
  const pendingWorkspaceFocus = useRef<"files" | "conversation" | null>(null);
  const [workspaceFocusVersion, requestWorkspaceFocus] = useState(0);
  const panelPrefix = useId();
  const hasWorkspace = Boolean(workHeader);
  const searchParams = useSearchParams();
  const pairedView = sending || frozenDraft ? submittedView : readPairedSessionView(searchParams.get("sessionView"));
  const setPairedView = (view: PairedSessionView) => {
    if (sending || frozenDraft || pairedView === view) return;
    const url = new URL(window.location.href);
    if (view === "both") url.searchParams.delete("sessionView");
    else url.searchParams.set("sessionView", view.toLowerCase());
    window.history.replaceState(null, "", url.href);
  };
  const selectedPanel = hasWorkspace ? searchParams.get("panel") ?? "conversation" : localPanel;
  const setSelectedPanel = useCallback((panel: string) => {
    if (!hasWorkspace) { setLocalPanel(panel); return; }
    const url = new URL(window.location.href);
    if (panel === "conversation") url.searchParams.delete("panel");
    else url.searchParams.set("panel", panel);
    window.history.replaceState(null, "", url.href);
  }, [hasWorkspace]);
  const [pending, setPending] = useState<{ runId: string; text: string; afterOffset: number; attachments?: WorkAttachment[] } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const startupContainer = useRef<HTMLDivElement>(null);
  const earlierScroll = useRef<{ top: number; height: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const nearBottom = useRef(true);
  const history = useRef(new Map<string, ConversationEvent>());
  const cursor = useRef<string | null>(null);
  const previous = useRef<string | null>(null);
  const session = useRef<string | null>(null);
  const readBusy = useRef(false);
  const promptHash = useRef<string | null>(null);
  const latestRunId = useRef(runId);
  const reload = useRef<() => Promise<void>>(async () => {});
  const { canSteer, canFollowUp, canQueue } = conversationControlCapabilities(data, runtimeEngine, runId, isLive);
  const authentication = useCaseIqAuthentication(workId, runId, runtimeEngine === "CASEIQ" && runId !== null,
    visible && (lane !== undefined || hasWorkspace && selectedPanel === "conversation"));
  const toolPermissions = useCaseIqToolPermissions(workId, runId, runtimeEngine === "CASEIQ" && runId !== null);
  const authenticationCommand = runtimeEngine === "CASEIQ" && isCaseIqAuthenticationCommand(draft);
  const canSubmit = !authentication.reserved && (isLive ? canQueue : canFollowUp);
  const laneKind = lane?.kind;
  const laneSessionId = lane?.sessionId;
  useEffect(() => {
    if (!laneKind || !onLaneControl) return;
    const queued = Boolean(data?.canQueue && data.queueParentRunId);
    const matches = data && data.sessionId === laneSessionId && data.anchorRunId === runId;
    const parentRunId = data && matches && !conversationReadError && !authentication.reserved
      ? queued ? data.queueParentRunId : data.canFollowUp ? data.continuationParentRunId : null
      : null;
    onLaneControl(laneKind, { parentRunId, queued, blockedReason: parentRunId ? null
      : conversationReadError ?? (authentication.reserved ? "Finish SupportIQ sign-in first."
        : !runId ? "The original Run is unavailable."
          : !matches ? null
            : (isLive ? data.queueBlockedReason : data.blockedReason) ?? "No recorded Session to continue.") });
  }, [laneKind, laneSessionId, onLaneControl, data, runId, conversationReadError, authentication.reserved, isLive]);
  const targets = pairedViewLanes(pairedView);
  const pairReady = paired && !paired.sendBlockedReason && targets.every((kind) => laneControls[kind]?.parentRunId);
  const pairQueues = targets.some((kind) => laneControls[kind]?.queued);
  const pairedAuthenticationDraft = Boolean(paired && isCaseIqAuthenticationCommand(draft));
  const pairTargetLabel = pairedView === "both" ? "both Sessions" : pairedLaneInfo[pairedView].label;
  const hasPairedSessions = Boolean(paired);

  const updateDraft = useCallback((value: string) => {
    draftValue.current = value;
    draftSelection.current = null;
    pendingDraftSelection.current = null;
    setDraftInsertionError(null);
    setDraft(value);
  }, []);

  const insertPath = useCallback((path: string) => {
    if (sending || frozenDraft || draftComposing || attempt.current?.dispatched) {
      setDraftInsertionError("This draft is locked. Resolve the current submission before inserting a path.");
      return;
    }
    const value = draftValue.current;
    const selection = draftSelection.current;
    const result = insertPromptName(value, path, selection);
    if (result.ok) {
      updateDraft(result.value);
      draftSelection.current = result.selection;
      pendingDraftSelection.current = result.selection;
    } else {
      setDraftInsertionError(result.error);
      pendingDraftSelection.current = selection ?? { start: value.length, end: value.length };
    }
    setSelectedPanel("conversation");
    setView("conversation");
    setFocusRequest((current) => current + 1);
  }, [sending, frozenDraft, draftComposing, updateDraft, setSelectedPanel]);

  const composerContext = useMemo(() => ({
    workId, disabled: sending || frozenDraft || draftComposing, insertPath,
  }), [workId, sending, frozenDraft, draftComposing, insertPath]);

  function rememberDraftSelection(element: HTMLTextAreaElement) {
    draftSelection.current = { start: element.selectionStart, end: element.selectionEnd };
  }

  useLayoutEffect(() => {
    const selection = pendingDraftSelection.current;
    if (!selection || selectedPanel !== "conversation" || view !== "conversation") return;
    restorePromptSelection(textarea.current, selection);
    draftSelection.current = selection;
    pendingDraftSelection.current = null;
  }, [draft, focusRequest, selectedPanel, view]);

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

  function endpoint(extra?: { cursor?: string; before?: string; download?: string; pin?: string }) {
    const query = new URLSearchParams({ ...(runId ? { runId } : {}), ...extra });
    return `/api/works/${encodeURIComponent(workId)}/conversation?${query}`;
  }

  useEffect(() => {
    if (hasPairedSessions || laneSessionId && !runId) return;
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
            if (laneSessionId) setNewPairedMessages(false);
            setData(null);
            setPinWindow(null); setPinTarget(null);
            setEarlierReadError(null);
            setNotice("The stored session changed. Its conversation is being reloaded.");
            again = true;
            return;
          }
          throw new Error(typeof body.error === "string" ? body.error : "Unable to load conversation");
        }
        const page = body as SessionConversationData;
        if (laneSessionId && page.sessionId !== laneSessionId) throw new Error("The returned history did not match this Session.");
        if (session.current !== null && session.current !== page.sessionId) {
          history.current.clear(); cursor.current = null; previous.current = null;
          session.current = page.sessionId;
          setData(null);
          setEvents([]);
          setPinWindow(null); setPinTarget(null);
          setEarlierReadError(null);
          setNotice("A different session is now selected. Your draft has been kept.");
          again = true;
          return;
        }
        const firstPage = cursor.current === null;
        session.current = page.sessionId;
        let changed = false;
        let appendedMessage = false;
        for (const event of page.events) {
          if (history.current.has(event.id)) continue;
          history.current.set(event.id, event);
          changed = true;
          if (laneSessionId && !firstPage && isConversationMessage(event)) appendedMessage = true;
        }
        if (appendedMessage && !nearBottom.current) setNewPairedMessages(true);
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
        const updatedRunId = laneSessionId ? page.displayRunId : page.runs[0]?.id;
        if (updatedRunId && latestRunId.current !== updatedRunId) {
          latestRunId.current = updatedRunId;
          if (updatedRunId !== runId) router.refresh();
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
    const refreshPaired = (event: Event) => {
      const detail = (event as CustomEvent<{ workId: string; sessions: string[] }>).detail;
      if (detail?.workId !== workId || !laneSessionId || !detail.sessions.includes(laneSessionId)) return;
      refresh();
    };
    void load();
    const timer = setInterval(refresh, 4000);
    window.addEventListener("focus", refresh);
    if (laneSessionId) window.addEventListener("workboard:paired-follow-up-changed", refreshPaired);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true; controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("workboard:paired-follow-up-changed", refreshPaired);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workId, runId, router, hasPairedSessions, laneSessionId]);

  const pairedPendingPromptId = laneSessionId ? data?.pendingPrompt?.runId : undefined;
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || laneSessionId && (!visible || !element.clientHeight)) return;
    if (earlierScroll.current) {
      element.scrollTop = earlierScroll.current.top + element.scrollHeight - earlierScroll.current.height;
      earlierScroll.current = null;
    } else if (nearBottom.current && !pinWindow) {
      element.scrollTop = element.scrollHeight;
    }
  }, [events, pending, pinWindow, laneSessionId, visible, pairedPendingPromptId]);

  useEffect(() => () => {
    earlierController.current?.abort();
  }, [workId, runId, view, selectedPanel]);

  useEffect(() => () => {
    pinController.current?.abort();
    pendingPinJump.current?.reject(new Error("Pin navigation was cancelled because the selected Run changed."));
    pendingPinJump.current = null;
  }, [workId, runId, setSelectedPanel]);

  useLayoutEffect(() => {
    const jump = pendingPinJump.current;
    const element = container.current;
    if (!jump || !element || view !== "conversation" || selectedPanel !== "conversation") return;
    const target = [...element.querySelectorAll<HTMLElement>("[data-conversation-line]")].find((entry) =>
      entry.dataset.conversationEvent === jump.pin.eventId && Number(entry.dataset.conversationLine) === jump.pin.line);
    pendingPinJump.current = null;
    if (!target) { jump.reject(new Error("This pinned line is not present in the rendered output.")); return; }
    const nested = target.closest("pre");
    if (nested && nested.scrollHeight > nested.clientHeight) {
      nested.scrollTop += target.getBoundingClientRect().top - nested.getBoundingClientRect().top - nested.clientHeight / 2;
    }
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2;
    target.focus({ preventScroll: true });
    jump.resolve();
  }, [pinTarget, pinWindow, view, selectedPanel]);

  const navigateToPin = useCallback(async (pin: ConversationPin) => {
    if (!runId || pin.sessionId !== session.current) throw new Error("This Pin belongs to a different Session.");
    earlierController.current?.abort();
    setEarlierReadError(null);
    const controller = new AbortController();
    pinController.current?.abort();
    pinController.current = controller;
    setPinLoading(true);
    try {
      const query = new URLSearchParams({ runId, pin: pin.id });
      const response = await fetch(`/api/works/${encodeURIComponent(workId)}/conversation?${query}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to locate Pin.");
      const page = body as SessionConversationData;
      const target = page.events?.find((event) => event.id === pin.eventId);
      if (controller.signal.aborted || page.sessionId !== session.current || !target) throw new Error("The Pin no longer matches the selected Session.");
      nearBottom.current = false;
      earlierScroll.current = null;
      setPinWindow(history.current.get(pin.eventId)?.text === target.text ? null : page);
      setSelectedPanel("conversation");
      setView("conversation");
      await new Promise<void>((resolve, reject) => {
        pendingPinJump.current = { pin, resolve, reject };
        setPinTarget({ ...pin });
      });
    } finally {
      if (pinController.current === controller) { pinController.current = null; setPinLoading(false); }
    }
  }, [workId, runId, setSelectedPanel]);

  function showLatest() {
    earlierController.current?.abort();
    setEarlierReadError(null);
    pinController.current?.abort();
    pendingPinJump.current?.reject(new Error("Pin navigation was cancelled."));
    pendingPinJump.current = null;
    setPinWindow(null); setPinTarget(null);
    setSelectedPanel("conversation"); setView("conversation");
    nearBottom.current = true;
    if (laneSessionId) setNewPairedMessages(false);
    const behavior = laneSessionId ? "instant" : "smooth";
    requestAnimationFrame(() => {
      const element = container.current;
      if (element) element.scrollTo({ top: element.scrollHeight, behavior });
    });
  }

  useEffect(() => {
    if (laneSessionId) return;
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
  }, [workId, setSelectedPanel, laneSessionId]);

  async function loadEarlier() {
    const before = pinWindow ? pinWindow.previousCursor : previous.current;
    if (!before || readBusy.current || earlierScroll.current || pinLoading) return;
    readBusy.current = true;
    const controller = new AbortController();
    earlierController.current = controller;
    const expectedSession = session.current;
    const batch: { page: SessionConversationData | null; events: Map<string, ConversationEvent> } = { page: null, events: new Map() };
    let discard = false;
    setEarlierLoading(true);
    setEarlierReadError(null);
    nearBottom.current = false;
    try {
      await readEarlierConversationPages(before, async (cursor) => {
        const response = await fetch(endpoint({ before: cursor }), { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to load earlier messages");
        if (body.sessionId !== expectedSession) {
          discard = true;
          throw new Error("The Session changed while loading earlier messages. Refresh the conversation.");
        }
        if (!Array.isArray(body.events) || !(body.previousCursor === null || typeof body.previousCursor === "string" && body.previousCursor.length > 0)) {
          throw new Error("The server returned an invalid earlier-history page.");
        }
        return body as SessionConversationData;
      }, (page) => {
        batch.page = page;
        page.events.forEach((event) => batch.events.set(event.id, event));
      }, { knownIds: pinWindow ? pinWindow.events.map((event) => event.id) : history.current.keys(), signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) setEarlierReadError(error instanceof Error ? error.message : "Unable to load earlier messages");
    } finally {
      const page = batch.page;
      if (!controller.signal.aborted && !discard && page && session.current === expectedSession) {
        if (container.current) earlierScroll.current = { top: container.current.scrollTop, height: container.current.scrollHeight };
        if (pinWindow) {
          const merged = new Map([...pinWindow.events, ...batch.events.values()].map((event) => [event.id, event]));
          setPinWindow({ ...pinWindow, events: [...merged.values()].sort((left, right) => left.offset - right.offset),
            previousCursor: page.previousCursor, hasEarlier: page.previousCursor !== null });
        } else {
          batch.events.forEach((event) => history.current.set(event.id, event));
          previous.current = page.previousCursor;
          setEvents([...history.current.values()].sort((left, right) => left.offset - right.offset));
          setData((current) => current ? { ...current, previousCursor: page.previousCursor, hasEarlier: page.previousCursor !== null } : page);
        }
      }
      if (earlierController.current === controller) earlierController.current = null;
      readBusy.current = false;
      setEarlierLoading(false);
    }
  }

  async function loadLaterPinnedMessages() {
    if (!pinWindow?.hasMore || !pinWindow.nextCursor || readBusy.current || pinLoading) return;
    readBusy.current = true;
    setEarlierLoading(true);
    try {
      const response = await fetch(endpoint({ cursor: pinWindow.nextCursor }), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to load later messages.");
      const page = body as SessionConversationData;
      const merged = new Map([...pinWindow.events, ...page.events].map((event) => [event.id, event]));
      setPinWindow({ ...pinWindow, events: [...merged.values()].sort((left, right) => left.offset - right.offset),
        nextCursor: page.nextCursor, hasMore: page.hasMore });
      setReadError(null);
    } catch (error) { setReadError(error instanceof Error ? error.message : "Unable to load later messages."); }
    finally { readBusy.current = false; setEarlierLoading(false); }
  }

  async function sendToPair(text: string) {
    if (!paired || pairSending.current || (!text && !attachments.files.length)) return;
    if (isCaseIqAuthenticationCommand(text)) {
      setSendError("Use Sign in to SupportIQ in the CaseIQ pane. This command is not sent to either Session.");
      return;
    }
    if (!frozenDraft && !pairReady) return;
    const selected = targets.flatMap((kind) => {
      const parentRunId = laneControls[kind]?.parentRunId;
      return parentRunId ? [{ lane: kind, expectedParentRunId: parentRunId }] : [];
    });
    const previous = pairedAttempt.current;
    const retrying = previous?.attachmentIds !== undefined;
    if (!retrying && selected.length !== targets.length) return;
    const draftFileIds = attachments.files.map((file) => file.id).join(",");
    const submission: PairedAttempt = previous && (retrying || previous.prompt === text && previous.draftFileIds === draftFileIds &&
      JSON.stringify(previous.targets) === JSON.stringify(selected))
      ? previous : { action: "follow-up", requestId: window.crypto.randomUUID(), prompt: text, draftFileIds, targets: selected };
    pairSending.current = true;
    pairedAttempt.current = submission;
    setSubmittedView(pairedView);
    setSending(true); setSendError(null); setNotice(null);
    const { action, requestId, prompt, targets: frozenTargets } = submission;
    const destinations = frozenTargets.map(({ lane: kind }) => ({ lane: kind, sessionId: paired.lanes[kind].sessionId }));
    const sessions = destinations.map(({ sessionId }) => sessionId);
    const refreshTargets = () => window.dispatchEvent(new CustomEvent("workboard:paired-follow-up-changed", { detail: { workId, sessions } }));
    try {
      const attachmentIds = submission.attachmentIds ?? (await attachments.upload(requestId)).map(({ id }) => id);
      submission.attachmentIds = attachmentIds;
      setFrozenDraft(true);
      const response = await fetch(`/api/works/${encodeURIComponent(workId)}/paired-sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, requestId, prompt, targets: frozenTargets, attachmentIds }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500 && (!retrying || body.admissionRejected === true)) {
          pairedAttempt.current = null; setFrozenDraft(false);
          refreshTargets();
        }
        throw new Error(typeof body.error === "string" ? body.error : "Paired Follow Up was not confirmed.");
      }
      const receipt = readPairedFollowUpReceipt(body, destinations);
      if (!receipt) throw new Error("The receipt did not confirm every targeted Session.");
      refreshTargets();
      setPairedReceipt(receipt);
      pairedAttempt.current = null;
      updateDraft(""); attachments.clear(); setFrozenDraft(false);
      router.refresh();
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : "Paired Follow Up was not confirmed.");
    } finally { pairSending.current = false; setSending(false); }
  }

  async function send(event?: React.FormEvent, action?: "steer") {
    event?.preventDefault();
    const text = draft.trim();
    if (paired) return sendToPair(text);
    if (runtimeEngine === "CASEIQ" && isCaseIqAuthenticationCommand(text) && !attempt.current?.dispatched) {
      if (attachments.files.length || isLive || sending || frozenDraft || steeringRequestState) {
        setSendError("Sign-in accepts no attachments and must wait for the current Run or message to finish.");
        return;
      }
      try {
        await authentication.start();
        updateDraft("");
        setSendError(null);
        setNotice("The original CaseIQ authentication window was requested. No task Prompt or Follow Up was sent.");
      } catch (reason) { setSendError(reason instanceof Error ? reason.message : "Authentication could not be started."); }
      return;
    }
    if (authentication.reserved) {
      setSendError("Finish the SupportIQ authentication window before sending another message.");
      return;
    }
    const fileIds = attachments.files.map((file) => file.id).join(",");
    const requestedKind = action === "steer" ? "steer" : isLive ? "queue" : "follow-up";
    const kind = attempt.current?.dispatched ? attempt.current.kind : requestedKind;
    const useSteering = kind === "steer";
    const useQueue = kind === "queue";
    const permitted = useSteering ? canSteer : useQueue ? canQueue : canFollowUp;
    const expectedParentRunId = useQueue ? data?.queueParentRunId : data?.continuationParentRunId;
    if ((!text && !attachments.files.length) || sending || (steeringUncertain && steeringUncertain.text !== text) ||
      (steeringRequest.current && steeringRequest.current.text !== text) ||
      (!attempt.current?.dispatched && !permitted) || conversationReadError !== null) return;
    setSending(true); setSendError(null);
    try {
      if (!attempt.current || !attempt.current.dispatched && (
        attempt.current.text !== text || attempt.current.fileIds !== fileIds ||
        attempt.current.kind !== kind ||
        attempt.current.runId !== (data?.steeringRunId ?? "") ||
        attempt.current.sessionId !== (data?.sessionId ?? "") ||
        attempt.current.expectedParentRunId !== expectedParentRunId
      )) {
        attempt.current = {
          requestId: window.crypto.randomUUID(), text, fileIds, kind,
          runId: data?.steeringRunId ?? "", sessionId: data?.sessionId ?? "",
          expectedParentRunId, dispatched: false,
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
        updateDraft("");
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
        body: JSON.stringify({ prompt: text, expectedParentRunId: sendAttempt.expectedParentRunId, requestId: sendAttempt.requestId, attachmentIds,
          ...(useQueue ? { queue: true } : {}) }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.runId !== "string" || useQueue && (body.queued !== true || body.sessionId !== sendAttempt.sessionId)) {
        if (!response.ok && response.status < 500) { sendAttempt.dispatched = false; setFrozenDraft(false); }
        throw new Error(typeof body.error === "string" ? body.error : useQueue ? "Queue admission was not confirmed. Retry this same request." : "Follow Up did not start");
      }
      if (useQueue) {
        setNotice("Message added to queue.");
      } else {
        setPending({ runId: body.runId, text, attachments: savedAttachments, afterOffset: events.at(-1)?.offset ?? -1 });
      }
      updateDraft("");
      if (!useQueue) nearBottom.current = true;
      attachments.clear(); setFrozenDraft(false); attempt.current = null;
      if (!useQueue) window.dispatchEvent(new CustomEvent("workboard:prompt-updated", { detail: { workId } }));
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
  const timeline = conversationTimeline(withPendingFollowUp(pinWindow?.events ?? events, pendingMessage && !pinWindow ? {
    ...pendingMessage,
    timestamp: "timestamp" in pendingMessage ? pendingMessage.timestamp ?? null : pendingRun?.createdAt ?? null,
    afterOffset: "afterOffset" in pendingMessage ? pendingMessage.afterOffset : undefined,
  } : null));
  const caseIqLive = isLive && !awaitingRunStart && runtimeEngine === "CASEIQ" && runId !== null;
  const Toolbar = workHeader ? "header" : "div";
  const headingId = lane ? `${panelPrefix}-session-heading` : "session-conversation-heading";
  const tabs = [
    { id: "conversation", label: "Conversation" },
    ...panels,
    ...(fileBrowser && !wideFiles ? [{ id: "files", label: "Files" }] : []),
  ];
  const activePanel = tabs.some((tab) => tab.id === selectedPanel) ? selectedPanel : "conversation";
  useLayoutEffect(() => {
    const target = pendingWorkspaceFocus.current;
    if (target === "files" && (wideFiles || activePanel === "files")) {
      const panel = filesPanel.current;
      const selectedLocation = panel?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      (selectedLocation ?? panel)?.focus();
    } else if (target === "conversation" && activePanel === "conversation") {
      const opener = resultFilesOpener.current;
      const visibleOpener = opener?.getClientRects().length ? opener : null;
      (visibleOpener ?? document.getElementById(`${panelPrefix}-tab-conversation`))?.focus();
      resultFilesOpener.current = null;
    } else {
      return;
    }
    pendingWorkspaceFocus.current = null;
  }, [activePanel, panelPrefix, wideFiles, workspaceFocusVersion]);

  function openResultFiles(kind: PairedWorkLane, opener: HTMLButtonElement) {
    resultFilesOpener.current = wideFiles ? null : opener;
    fileLocations.selectLocation(kind);
    pendingWorkspaceFocus.current = "files";
    requestWorkspaceFocus((current) => current + 1);
    if (!wideFiles) setSelectedPanel("files");
  }

  function returnToConversation() {
    pendingWorkspaceFocus.current = "conversation";
    requestWorkspaceFocus((current) => current + 1);
    setSelectedPanel("conversation");
  }

  const usageInSidebar = hasWorkspace && verticalTabs;
  const disclosureGroup = lane ? `${panelPrefix}-session-resources` : undefined;
  const sessionUsage = activePanel === "conversation" && view === "conversation" && data?.sessionId && data.anchorRunId === runId
    ? <SessionUsagePanel usage={readError ? null : data.sessionUsage ?? null} expanded={usageInSidebar} disclosureGroup={disclosureGroup} /> : null;

  useEffect(() => {
    const progress = startupContainer.current;
    const history = container.current;
    if (!history || pinWindow || view !== "conversation" || activePanel !== "conversation" || !visible ||
        (!laneSessionId && (!caseIqLive || !progress))) return;
    const follow = () => {
      if (nearBottom.current && history.clientHeight) history.scrollTop = history.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    if (laneSessionId) observer.observe(history);
    if (caseIqLive && progress) observer.observe(progress);
    return () => observer.disconnect();
  }, [caseIqLive, runId, pinWindow, view, activePanel, laneSessionId, visible]);

  const sidebarId = `${panelPrefix}-work-sidebar`;
  const filesId = `${panelPrefix}-panel-files`;
  const sidebar = hasWorkspace ? <div id={sidebarId} className="work-conversation-sidebar">
    <div className="work-section-tabs" role="tablist" aria-label="Work sections" aria-orientation={verticalTabs ? "vertical" : "horizontal"}
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
    </div>
    {usageInSidebar && sessionUsage}
  </div> : null;
  const files = fileBrowser ? <aside ref={filesPanel} id={filesId} aria-label="Work files" role={wideFiles ? undefined : "tabpanel"}
    aria-labelledby={wideFiles ? undefined : `${panelPrefix}-tab-files`}
    hidden={!wideFiles && activePanel !== "files"} tabIndex={paired ? -1 : undefined} className="work-files-panel">
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1"><FollowUpComposerContext.Provider value={composerContext}>
        <WorkFileNavigationContext.Provider value={paired
          ? { ...fileLocations, returnToConversation: wideFiles ? undefined : returnToConversation } : null}>
          {fileBrowser}
        </WorkFileNavigationContext.Provider>
      </FollowUpComposerContext.Provider></div>
      {!paired && <ConversationPinsPanel />}
    </div>
  </aside> : null;

  const signInCallout = runtimeEngine === "CASEIQ" && runId ? <CaseIqSignInCallout authentication={authentication} /> : null;
  const queuedCount = data?.queuedMessageCount ?? 0;
  const queueTitle = `${queuedCount} queued message${queuedCount === 1 ? "" : "s"}`;
  const queueItems = queuedCount > 0 && <>
      <ol className="mt-1 space-y-1" aria-label="Queued messages in execution order">
        {data?.queuedMessages.map((message, index) => <li key={message.runId}>
          <Link href={`/runs/${message.runId}`} className="block min-h-11 rounded-md px-2 py-1 hover:bg-neutral-800">
            <span className="flex items-center gap-2 text-neutral-500"><ListPlus size={12} aria-hidden="true" />#{index + 1}
              <time className="ml-auto text-[10px]" dateTime={message.createdAt}>{eventTime(message.createdAt, true)}</time>
            </span>
            <span className="line-clamp-2 break-words text-neutral-300">{message.text || message.attachments.map((file) => file.name).join(", ")}</span>
          </Link>
        </li>)}
      </ol>
      {data && data.queuedMessageCount > data.queuedMessages.length && <p className="mt-1 text-neutral-500">Showing the first {data.queuedMessages.length} queued messages. All messages remain in Run history.</p>}
  </>;
  const composerNotices = <>
    {signInCallout}
    {queueItems && <div className="mb-2 max-h-32 overflow-y-auto rounded-md border border-neutral-800 p-2 text-xs" aria-label="Queued messages">
      <p role="status" className="font-semibold text-neutral-400">{queueTitle} · Runs execute in order</p>
      {queueItems}
    </div>}
  </>;

  const composerHelpId = `${panelPrefix}-composer-help`;
  const pairedTargetsHintId = `${panelPrefix}-target-hints`;
  const pairedAuthHintId = `${panelPrefix}-auth-hint`;
  const draftAttachments = <AttachmentDraft {...attachments} disabled={sending || frozenDraft} />;
  const sendButton = <button ref={submitButton} type="submit" disabled={sending || (!draft.trim() && !attachments.files.length) ||
    (paired ? !frozenDraft && (!pairReady || pairedAuthenticationDraft) :
    (steeringUncertain !== null && steeringUncertain.text !== draft.trim()) ||
    (steeringRequestState !== null && steeringRequestState.text !== draft.trim()) ||
    (!frozenDraft && !steeringRequestState && (authenticationCommand
      ? !authentication.status?.available || authentication.reserved || isLive
      : !canSubmit)) || conversationReadError !== null)} className="ui-primary-button">
    {sending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      : (paired ? pairQueues : isLive && !steeringRequestState) ? <ListPlus size={14} aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
    {paired ? sending ? "Submitting..." : `${frozenDraft ? "Retry for" : "Send to"} ${pairTargetLabel}`
      : authenticationCommand ? "Open SupportIQ sign-in" : steeringRequestState ? "Retry / repair Steering" : frozenDraft ? "Retry message" : isLive ? "Add to Queue" : "Send Follow Up"}
  </button>;
  const workspaceHeight = viewportHeight === null ? `calc(100dvh - ${navigationHeight}px - 1rem)` : `${Math.max(120, viewportHeight - navigationHeight - 16)}px`;
  const workspaceStyle: (CSSProperties & { "--work-detail-viewport-height"?: string }) | undefined = !hasWorkspace
    ? undefined : paired ? { "--work-detail-viewport-height": workspaceHeight } : { height: workspaceHeight };

  return (
    <ConversationPinsProvider workId={workId} runId={runId} sessionId={data?.sessionId ?? null}
      activePin={pinTarget} onActivePinChange={setPinTarget} onNavigate={navigateToPin}>
    <div id={lane ? `${panelPrefix}-session` : "session-conversation"}
      className={hasWorkspace ? `work-detail-layout min-w-0${paired ? " work-detail-layout-paired" : ""}` : lane ? "work-paired-session" : "min-w-0 space-y-2"}
      style={workspaceStyle}>
      {lane ? <PairedLaneToolbar lane={lane.kind} sessionId={lane.sessionId} headingId={headingId} runActions={runActions}
        raw={view === "raw"} hasRun={runId !== null} showLatest={events.length > 0 || pinWindow ? showLatest : undefined}
        newMessages={newPairedMessages} resultFiles={resultFiles}
        downloadHref={runId && (data?.historyAvailable || conversationReadError) ? endpoint({ download: "1" }) : undefined}
        toggleRaw={() => setView((current) => current === "raw" ? "conversation" : "raw")} />
      : <Toolbar className={`work-conversation-toolbar flex flex-wrap items-center gap-x-2 gap-y-1${workHeader ? " work-detail-header work-detail-unified-toolbar" : ""}`}
        style={workHeader ? { top: `calc(${navigationHeight}px + 0.5rem)` } : undefined}>
        {workHeader}
        <h2 id={headingId} className={workHeader ? "sr-only" : "flex shrink-0 items-center gap-2 text-xs font-bold text-white sm:text-sm"}>
          <Radio size={14} aria-hidden="true" />
          Session conversation
        </h2>
        {!paired && <div className={`flex shrink-0 items-center gap-1${workHeader ? " work-toolbar-view-switch" : ""}`} role="tablist" aria-label="Session view">
          {(["conversation", "raw"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={view === tab}
            onClick={() => { setSelectedPanel("conversation"); setView(tab); }} className={`work-toolbar-control min-h-8 rounded-md px-2 py-1 text-xs font-semibold ${view === tab ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:text-neutral-100"}`}>
            {tab === "conversation" ? "Conversation" : "Raw output"}
          </button>)}
        </div>}
        {runActions}
        {!paired && <div className={`${workHeader ? "" : "ml-auto "}flex shrink-0 items-center gap-1 text-[10px] text-neutral-400`}>
          {data?.sessionId && <span className={workHeader ? "sr-only" : "font-mono"} title={data.sessionId}>Session {data.sessionId.slice(0, 8)}</span>}
          {runId && (data?.historyAvailable || conversationReadError) && <a href={endpoint({ download: "1" })} title="Download full session history" aria-label="Download full session history" className="work-toolbar-control grid size-8 place-items-center rounded-md hover:bg-neutral-800 hover:text-emerald-400"><Download size={14} aria-hidden="true" /></a>}
          {view === "conversation" && <button type="button" title="Latest messages" aria-label="Latest messages" onClick={showLatest}
            className="work-toolbar-control grid size-8 place-items-center rounded-md hover:bg-neutral-800"><ArrowDown size={14} aria-hidden="true" /></button>}
        </div>}
        {workActions}
      </Toolbar>}
      <WorkWorkspace sidebar={sidebar} sidebarId={sidebarId} files={files} filesId={filesId}>
        <section id={`${panelPrefix}-panel-conversation`} role={hasWorkspace ? "tabpanel" : undefined}
          aria-labelledby={hasWorkspace ? `${panelPrefix}-tab-conversation` : headingId}
          hidden={activePanel !== "conversation"} className={hasWorkspace || lane
            ? `work-conversation-panel${paired ? " work-paired-conversation" : ""}` : "space-y-2"}>
          {lane && notices ? <div className="work-paired-run-notices">{notices}</div> : notices}
          {paired ? <PairedSessionPanels view={pairedView} setView={setPairedView} locked={sending || frozenDraft}
            renderLane={(kind, shown) => {
              const { sessionId, ...display } = paired.lanes[kind];
              return <SessionConversation key={sessionId} workId={workId} {...display} runtimeEngine={kind} historySync={false}
                lane={{ kind, sessionId }} visible={shown && activePanel === "conversation"} onLaneControl={recordLaneControl}
                resultFiles={fileBrowser && hasWorkspace ? { panelId: filesId, open: (opener) => openResultFiles(kind, opener) } : undefined}
                onOpenConfiguration={kind === "CASEIQ" ? () => setSelectedPanel("mcp") : undefined} />;
            }} />
          : <>
          {isLive && runId && runtimeEngine === "SDK" && <ManagedRuntimePanel key={runId} workId={workId} runId={runId} />}
          {runtimeEngine === "CASEIQ" && runId && <div className="caseiq-runtime-banners" aria-label="CaseIQ access controls">
            <CaseIqAuthenticationPanel authentication={authentication} />
            <CaseIqToolPermissionsPanel permissions={toolPermissions}
              onOpenConfiguration={onOpenConfiguration ?? (hasWorkspace && panels.some((panel) => panel.id === "mcp")
                ? () => setSelectedPanel("mcp") : undefined)} />
          </div>}
          {notice && <p role="status" className="text-xs text-neutral-500">{notice}</p>}
          {conversationReadError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-400">{conversationReadError}<button type="button"
            onClick={() => { if (readError) void reload.current(); else void loadEarlier(); }} className="ui-secondary-button">Retry</button></div>}
          {pinWindow && <p role="status" className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
            Viewing pinned history. <button type="button" onClick={showLatest} className="underline">Back to latest messages</button>
          </p>}
          {view === "raw" ? <div className="work-raw-output">
            {caseIqLive && runId && <CaseIqStartupStatus key={`startup:${runId}`} runId={runId} />}
            {runId
              ? <LiveRunLog key={runId} runId={runId} initialLog={initialLog} isLive={isLive} historySync={historySync} outputFormat={outputFormat} refreshOnStatusChange={false} />
              : <p className="py-4 text-sm text-neutral-500">No Run output yet.</p>}</div>
          : <div ref={container} className="work-conversation-log max-h-[65dvh] min-h-48 overflow-y-auto overscroll-contain pr-2"
            role="log" aria-label={lane ? `${pairedLaneInfo[lane.kind].label} conversation` : "Session conversation"} tabIndex={lane ? 0 : undefined}
            aria-busy={(!lane || Boolean(runId)) && (loading || earlierLoading || pinLoading)}
            onWheel={(event) => handleConversationHistoryWheel(event, () => void loadEarlier())}
            onScroll={(change) => {
              const element = change.currentTarget;
              if (laneSessionId && (!visible || !element.clientHeight)) return;
              nearBottom.current = !pinWindow && !pinLoading &&
                element.scrollHeight - element.scrollTop - element.clientHeight < (laneSessionId ? 24 : 100);
              if (laneSessionId && nearBottom.current) setNewPairedMessages(false);
            }}>
            {lane && !runId ? <p role="status" className="py-3 text-sm text-neutral-400">The original Run is unavailable. No other Session was selected.</p>
              : loading && <p className="flex items-center gap-2 py-6 text-sm text-neutral-500"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />Loading conversation...</p>}
            {!loading && (pinWindow?.hasEarlier ?? data?.hasEarlier) && <p role="status" className="flex min-h-11 items-center justify-center gap-2 text-xs text-neutral-500">
              {earlierLoading
                ? <><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />Loading earlier messages...</>
                : <button type="button" aria-label="Load earlier messages" onClick={() => void loadEarlier()} className="min-h-11 px-2 hover:text-neutral-300">Scroll up to load earlier messages</button>}
            </p>}
            {!loading && !awaitingRunStart && timeline.length === 0 && <p className="py-6 text-sm text-neutral-500">{data?.historyUnavailableReason ?? "Waiting for recorded messages..."}</p>}
            <ConversationTimelineEntries timeline={timeline} workId={workId} isLive={isLive}
              pendingRun={pendingMessage ? { id: pendingMessage.runId, status: pendingRun?.status ?? "PENDING" } : undefined}
              startup={caseIqLive && runId && !pinWindow ? <div key={runId} ref={startupContainer}
                data-startup-run-id={runId} className="py-2 empty:hidden">
                <CaseIqStartupStatus runId={runId} onShowLogs={() => setView("raw")}
                  toolActivityAt={conversationToolActivityAt(events)} />
              </div> : undefined} />
            {runId && !awaitingRunStart && !pinWindow && timeline.length === 0 && (!lane || initialLog || isLive || runError) &&
              <section aria-label="Run startup and output" className="space-y-2 py-3">
              <h3 className="text-xs font-semibold text-neutral-300">Run startup and output</h3>
              <p className="text-xs text-neutral-500">
                Showing actual Run output while session history is unavailable, not recorded conversation messages.
                Recorded messages replace this view when they become available.
              </p>
              <LiveRunLog key={`startup:${runId}`} runId={runId} initialLog={initialLog} isLive={isLive}
                historySync={historySync} outputFormat={outputFormat} refreshOnStatusChange={false} />
            </section>}
            {pinWindow?.hasMore && <button type="button" disabled={earlierLoading || pinLoading} onClick={() => void loadLaterPinnedMessages()}
              className="min-h-11 w-full py-2 text-xs text-neutral-500">Load later messages</button>}
          </div>}
          {data?.incompleteTail && <p role="status" className="text-xs text-neutral-500">Waiting for the current event to finish writing.</p>}
          {runError}
          {!lane && !usageInSidebar && sessionUsage}
          {lane && <>
            {signInCallout}
            <div className="work-paired-lane-footer" role="group" aria-label={`${pairedLaneInfo[lane.kind].label} session details`}>
              {sessionUsage}
              {queueItems && <details className="work-paired-resource" name={disclosureGroup}>
                <summary className="work-paired-resource-toggle" title={queueTitle}>
                  <ListPlus size={13} aria-hidden="true" /> Queue <span className="work-paired-count">{queuedCount}</span>
                </summary>
                <div className="work-paired-queue-preview text-xs">
                  <p className="font-medium text-neutral-400">Messages run in order</p>
                  {queueItems}
                </div>
              </details>}
              <ConversationPinsPanel disclosureGroup={disclosureGroup} />
            </div>
          </>}
          </>}
          {!lane && <form onSubmit={(event) => void send(event)} className={paired ? "work-conversation-composer work-paired-composer" : "work-conversation-composer border-t border-neutral-800 pt-2"}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              if (!sending && !frozenDraft) attachments.add([...event.dataTransfer.files]);
            }}>
            {paired ? <>
              <div className="work-paired-composer-header">
                <label htmlFor="session-follow-up" className="shrink-0 text-xs font-semibold text-neutral-100">
                  Follow Up<span className="sr-only"> to {pairTargetLabel}</span>
                </label>
                <PairedFollowUpTargets view={pairedView} controls={laneControls} blockedReason={paired.sendBlockedReason}
                  locked={sending || frozenDraft} hintId={pairedTargetsHintId} />
              </div>
              {pairedAuthenticationDraft && <p id={pairedAuthHintId} role="status" className="text-xs text-amber-300">
                Use SupportIQ sign-in in the CaseIQ pane. This command won&apos;t be sent.
              </p>}
            </> : <>
              {composerNotices}
              <label htmlFor="session-follow-up" className="mb-1 block text-xs font-semibold text-neutral-300">
                {steeringRequestState ? "Steering status / repair" : "Follow Up"}
              </label>
            </>}
            <textarea id="session-follow-up" ref={textarea} value={draft} onChange={(event) => {
              updateDraft(event.target.value);
              rememberDraftSelection(event.currentTarget);
            }} onSelect={(event) => rememberDraftSelection(event.currentTarget)}
              onFocus={(event) => rememberDraftSelection(event.currentTarget)}
              onCompositionStart={() => setDraftComposing(true)} onCompositionEnd={() => setDraftComposing(false)}
              rows={2} maxLength={100000}
              aria-describedby={paired ? `${composerHelpId} ${pairedTargetsHintId}${pairedAuthenticationDraft ? ` ${pairedAuthHintId}` : ""}` : composerHelpId}
              placeholder={paired ? "Write a follow-up..." : isLive ? "Queue a follow-up for after the current Run..." : "Continue this conversation..."} disabled={sending || frozenDraft}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (!files.length) return;
                event.preventDefault();
                attachments.add(files);
                const pastedText = event.clipboardData.getData("text/plain");
                if (pastedText) {
                  const { selectionStart, selectionEnd } = event.currentTarget;
                  const value = draftValue.current;
                  const next = value.slice(0, selectionStart) + pastedText + value.slice(selectionEnd);
                  if (next.length > 100000) {
                    setDraftInsertionError("The message would exceed the 100,000-character Prompt limit.");
                    return;
                  }
                  updateDraft(next);
                  const selection = { start: selectionStart + pastedText.length, end: selectionStart + pastedText.length };
                  draftSelection.current = selection;
                  pendingDraftSelection.current = selection;
                  setFocusRequest((current) => current + 1);
                }
              }}
              onKeyDown={(event) => handleConversationComposerKeyDown(event, () => submitButton.current?.click())}
              className="ui-input min-h-14 w-full resize-y px-3 py-2 text-sm leading-5" />
            {paired ? <>
              <div className="work-paired-compose-actions">
                {draftAttachments}
                <p id={composerHelpId} className="work-paired-compose-hint">Enter to send · Shift+Enter for a new line</p>
                {sendButton}
              </div>
              <PairedFollowUpReceipt receipt={pairedReceipt} onDismiss={() => {
                textarea.current?.focus({ preventScroll: true });
                setPairedReceipt(null);
              }} />
            </> : <>
            {draftAttachments}
            {draftInsertionError && <p role="alert" className="mt-1 text-xs text-red-400">{draftInsertionError}</p>}
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p id={composerHelpId} className="text-[11px] leading-5 text-neutral-500">{isLive && !steeringRequestState ? "Enter to queue" : "Enter to send"} · Shift+Enter for a new line</p>
                <p className="text-xs text-neutral-500" role="status">
                  {steeringUncertain
                    ? "Acceptance is uncertain. Retry only with this exact draft and request ID, or explicitly dismiss it after checking session history."
                    : isLive
                      ? canQueue
                        ? canSteer
                          ? "Queued messages run after earlier Runs finish. Steer now sends immediately; it does not undo work or guarantee that a running tool stops."
                          : "Queued messages run in order after the current Run finishes, including after a failure or cancellation."
                        : data?.queueBlockedReason ?? "Waiting for queue permissions..."
                      : canFollowUp ? "" : data?.blockedReason ?? (data?.terminalActive ? "Session open in Terminal" : "")}
                </p>
              </div>
              {sendButton}
              {canSteer && !frozenDraft && !steeringRequestState && <button type="button" onClick={() => void send(undefined, "steer")}
                disabled={sending || (!draft.trim() && !attachments.files.length) || conversationReadError !== null} className="ui-secondary-button">
                <Send size={14} aria-hidden="true" />Steer now
              </button>}
            </div>
            </>}
            {paired && draftInsertionError && <p role="alert" className="text-xs text-red-400">{draftInsertionError}</p>}
            {sendError && <p role="alert" className="mt-2 text-sm text-red-400">{sendError}</p>}
            {frozenDraft && !steeringUncertain && !steeringRequestState && <p role="status" className="mt-1 text-xs text-neutral-400">
              This draft is frozen until delivery is resolved. Retry uses the same message and attachment IDs.
            </p>}
            {steeringUncertain && <button type="button" className="mt-2 text-xs text-amber-400 underline"
              onClick={() => {
                setSteeringUncertain(null);
                steeringRequest.current = null;
                setSteeringRequestState(null);
                updateDraft("");
                attachments.clear(); setFrozenDraft(false); attempt.current = null;
                setSendError(null);
              }}>
              Dismiss this uncertain draft after checking session history
            </button>}
          </form>}
        </section>
        {panels.map((panel) => <section key={panel.id} id={`${panelPrefix}-panel-${panel.id}`} role="tabpanel"
          aria-labelledby={`${panelPrefix}-tab-${panel.id}`} hidden={activePanel !== panel.id} tabIndex={0} className="work-secondary-panel">
          {panel.content}
        </section>)}
        {!fileBrowser && !lane && <ConversationPinsPanel />}
      </WorkWorkspace>
    </div>
    </ConversationPinsProvider>
  );
}