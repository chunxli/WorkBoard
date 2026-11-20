"use client";

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertCircle, ArrowDown, ArrowUpRight, Check, Columns2, Download, FolderOpen, GripVertical, ListPlus, MessageSquareText, TerminalSquare, X } from "lucide-react";
import CaseIqRuntimeTag from "@/components/CaseIqRuntimeTag";
import PaneResizeHandle from "@/components/PaneResizeHandle";
import {
  applyPairedSessionSplit, keyboardPairedSessionSplit, measuredPairedSessionSplit, movedPairedSessionSplit, PAIRED_SESSION_SPLIT_KEY,
  pairedSessionSplitLimits, readPairedSessionSplit,
} from "@/lib/work-pane-layout";
import { pairedLaneInfo, pairedWorkLanes, type PairedWorkLane, type PairedWorkReceipt } from "@/lib/work-session-pair";

export type PairedSessionView = "both" | PairedWorkLane;
export type PairedLaneControl = { parentRunId: string | null; blockedReason: string | null; queued: boolean };
const views = ["both", ...pairedWorkLanes] as const;
export const pairedViewLanes = (view: PairedSessionView): readonly PairedWorkLane[] => view === "both" ? pairedWorkLanes : [view];
export const readPairedSessionView = (value: string | null): PairedSessionView =>
  value === "cli" ? "CLI" : value === "caseiq" ? "CASEIQ" : "both";

export function PairedFollowUpTargets({ view, controls, blockedReason, locked, hintId }: {
  view: PairedSessionView;
  controls: Partial<Record<PairedWorkLane, PairedLaneControl>>;
  blockedReason: string | null;
  locked: boolean;
  hintId: string;
}) {
  const targets = pairedViewLanes(view);
  const reasons = locked || blockedReason ? [] : targets.flatMap((lane) => {
    const reason = controls[lane]?.blockedReason;
    return reason ? [{ lane, reason }] : [];
  });
  return <div className="work-paired-destinations" role="status">
    <ul className="work-paired-target-list" aria-label="Follow Up destinations">
      {targets.map((lane) => {
        const control = controls[lane];
        const state = locked ? "locked" : blockedReason || control?.blockedReason ? "blocked"
          : !control?.parentRunId ? "checking" : control.queued ? "queued" : "ready";
        const label = { locked: "Locked", blocked: "Unavailable", checking: "Checking...", queued: "Will queue", ready: "Ready" }[state];
        return <li key={lane} className="work-paired-target" data-state={state}>
          <span className="work-paired-target-dot" aria-hidden="true" />
          <strong>{pairedLaneInfo[lane].label}</strong>
          <span>{label}</span>
        </li>;
      })}
    </ul>
    <div id={hintId} className="work-paired-target-reasons">
      {!locked && blockedReason && <p>{blockedReason}</p>}
      {reasons.map(({ lane, reason }) => <p key={lane}><strong>{pairedLaneInfo[lane].label}:</strong> {reason}</p>)}
      {!locked && view === "both" && reasons.length > 0 && <p>Both Sessions must be available to send together.</p>}
    </div>
  </div>;
}

export function PairedFollowUpReceipt({ receipt, onDismiss }: {
  receipt: PairedWorkReceipt | null;
  onDismiss(): void;
}) {
  const outcomes = receipt?.runs.map(({ lane, queued }) =>
    `${pairedLaneInfo[lane].label}: ${queued ? "added to queue" : "accepted"}`);
  return <>
    <span role="status" className="sr-only">{outcomes && `Follow Up confirmed. ${outcomes.join(". ")}.`}</span>
    {receipt && <section aria-label="Last confirmed Follow Up" className="work-paired-receipt">
      <p className="work-paired-receipt-title"><Check size={14} aria-hidden="true" /> Last confirmed Follow Up</p>
      <ul className="work-paired-receipt-links">
        {receipt.runs.map(({ lane, runId, queued }) => {
          const label = pairedLaneInfo[lane].label;
          const status = queued ? "Added to queue" : "Accepted";
          return <li key={lane}>
            <a href={`/runs/${runId}`} target="_blank" rel="noopener noreferrer" data-queued={queued || undefined}
              aria-label={`Open ${label} Run in a new tab: ${status}`}
              title={`${status} at submission. Open Run for current status.`}>
              {queued ? <ListPlus size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
              <strong>{label}</strong> <span>{status}</span>
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </li>;
        })}
      </ul>
      <button type="button" className="work-toolbar-action work-paired-receipt-dismiss"
        title="Dismiss Follow Up receipt" aria-label="Dismiss Follow Up receipt" onClick={onDismiss}>
        <X size={14} aria-hidden="true" />
      </button>
    </section>}
  </>;
}

export type PairedResultFilesAction = { panelId: string; open(opener: HTMLButtonElement): void };

export function PairedLaneToolbar({ lane, sessionId, headingId, runActions, raw, hasRun, downloadHref, showLatest, newMessages, toggleRaw, resultFiles }: {
  lane: PairedWorkLane;
  sessionId: string;
  headingId: string;
  runActions?: ReactNode;
  raw: boolean;
  hasRun: boolean;
  downloadHref?: string;
  showLatest?: () => void;
  newMessages?: boolean;
  toggleRaw(): void;
  resultFiles?: PairedResultFilesAction;
}) {
  const resultFilesLabel = `Open ${pairedLaneInfo[lane].label} result files`;
  return <header className="work-conversation-toolbar work-paired-lane-toolbar">
    <div className="work-paired-lane-identity">
      <h2 id={headingId}>
        {lane === "CASEIQ" ? <CaseIqRuntimeTag /> : <><TerminalSquare size={15} aria-hidden="true" />Copilot CLI</>}
      </h2>
      <span className="work-paired-session-id" title={`Session ${sessionId}`}>{sessionId.slice(0, 8)}</span>
    </div>
    {runActions}
    {(hasRun || resultFiles) && <div className="work-paired-lane-actions" role="group" aria-label={`${pairedLaneInfo[lane].label} view actions`}>
      {resultFiles && <button type="button" className="work-toolbar-action work-toolbar-control size-8"
        title={resultFilesLabel} aria-label={resultFilesLabel} aria-controls={resultFiles.panelId}
        onClick={(event) => resultFiles.open(event.currentTarget)}>
        <FolderOpen size={15} aria-hidden="true" />
      </button>}
      {hasRun && <button type="button" className="work-toolbar-action work-toolbar-control size-8"
        aria-label="Raw output" aria-pressed={raw} title={raw ? "Back to conversation" : "Show raw output"} onClick={toggleRaw}>
        {raw ? <MessageSquareText size={14} aria-hidden="true" /> : <TerminalSquare size={14} aria-hidden="true" />}
      </button>}
      {showLatest && !raw && <button type="button" className="work-toolbar-action work-toolbar-control size-8"
        data-new-messages={newMessages || undefined}
        title={newMessages ? "New messages - jump to latest" : "Latest messages"}
        aria-label={newMessages ? `Jump to new ${pairedLaneInfo[lane].label} messages` : "Latest messages"}
        onClick={showLatest}><ArrowDown size={14} aria-hidden="true" /></button>}
      {newMessages && !raw && <span role="status" className="sr-only">New messages in {pairedLaneInfo[lane].label}.</span>}
      {downloadHref && <a className="work-toolbar-action work-toolbar-control size-8" href={downloadHref}
        title="Download full session history" aria-label="Download full session history"><Download size={14} aria-hidden="true" /></a>}
    </div>}
  </header>;
}

export default function PairedSessionPanels({ view, setView, locked, renderLane }: {
  view: PairedSessionView;
  setView: (view: PairedSessionView) => void;
  locked: boolean;
  renderLane: (lane: PairedWorkLane, visible: boolean) => ReactNode;
}) {
  const prefix = useId();
  const { min, max, initial } = pairedSessionSplitLimits;
  const [split, setSplit] = useState<number>(initial);
  const editedSplit = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const cliLane = useRef<HTMLDivElement>(null);
  const caseIqLane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (editedSplit.current) return;
      try {
        const saved = readPairedSessionSplit(window.localStorage.getItem(PAIRED_SESSION_SPLIT_KEY));
        applyPairedSessionSplit(document.documentElement.style, saved);
        setSplit(saved);
      } catch (error) {
        console.warn("[Work Board] Could not restore the paired Session split.", error);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  function previewSplit(value: number | null) {
    if (grid.current) applyPairedSessionSplit(grid.current.style, value);
  }

  function commitSplit(value: number) {
    editedSplit.current = true;
    applyPairedSessionSplit(document.documentElement.style, value);
    previewSplit(null);
    setSplit(value);
    try { window.localStorage.setItem(PAIRED_SESSION_SPLIT_KEY, JSON.stringify(value)); }
    catch (error) { console.warn("[Work Board] Could not save the paired Session split.", error); }
  }

  function switchView(next: PairedSessionView) {
    if (locked || next === view) return;
    previewSplit(null);
    setView(next);
  }

  function jumpToLane(lane: PairedWorkLane) {
    const scrollport = grid.current;
    const target = lane === "CLI" ? cliLane.current : caseIqLane.current;
    if (view !== "both" || !scrollport || !target) return;
    const top = scrollport.scrollTop + target.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
    target.focus({ preventScroll: true });
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    scrollport.scrollTo({ top, behavior });
    scrollport.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
  }

  return <div className="work-paired-sessions">
    <div className="work-paired-navigation">
      <div role="tablist" aria-label="Session focus" className="work-paired-tabs"
        onKeyDown={(event) => {
          if (locked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = views.indexOf(view);
          const next = views[event.key === "Home" ? 0 : event.key === "End" ? views.length - 1
            : (index + (event.key === "ArrowLeft" ? -1 : 1) + views.length) % views.length];
          switchView(next);
          document.getElementById(`${prefix}-${next}`)?.focus();
        }}>
        {views.map((value) => <button key={value} id={`${prefix}-${value}`} type="button" role="tab"
          aria-selected={value === view} aria-controls={`${prefix}-panel`} tabIndex={value === view ? 0 : -1}
          disabled={locked && value !== view} onClick={() => switchView(value)}
          className="work-paired-tab">
          {value === "both" && <Columns2 size={15} aria-hidden="true" />}
          {value === "both" ? "Both" : pairedLaneInfo[value].label}
        </button>)}
      </div>
      <p className={`work-paired-view-hint${!locked && view === "both" ? " work-paired-resize-hint" : ""}`}>
        {locked ? <><AlertCircle size={13} aria-hidden="true" /> Target locked for this draft</>
          : view === "both" ? "Drag the divider to resize" : `Focused on ${pairedLaneInfo[view].label}`}
      </p>
    </div>
    {view === "both" && <div className="work-paired-jumps" role="group" aria-label="Jump to a conversation without changing Follow Up destinations">
      <span aria-hidden="true">Jump to</span>
      {pairedWorkLanes.map((lane) => <button key={lane} type="button" className="work-toolbar-action"
        aria-label={`Jump to ${pairedLaneInfo[lane].label}`} aria-controls={`${prefix}-lane-${lane}`} onClick={() => jumpToLane(lane)}>
        {pairedLaneInfo[lane].label}
      </button>)}
    </div>}
    <div ref={grid} id={`${prefix}-panel`} role="tabpanel" aria-labelledby={`${prefix}-${view}`}
      className="work-paired-grid" data-paired-view={view}>
      {pairedWorkLanes.map((lane) => <Fragment key={lane}>
        <div ref={lane === "CLI" ? cliLane : caseIqLane} id={`${prefix}-lane-${lane}`} className="work-paired-lane" data-lane={lane}
          role="region" aria-label={`${pairedLaneInfo[lane].label} session`} hidden={view !== "both" && view !== lane} tabIndex={-1}>
          {renderLane(lane, view === "both" || view === lane)}
        </div>
        {view === "both" && lane === "CLI" && <PaneResizeHandle className="work-pane-divider work-paired-divider"
          label="Resize paired Sessions" controls={`${prefix}-lane-CLI`} title="Drag to resize. Double-click or press Enter to reset both widths."
          min={min} max={max} value={split} resetValue={initial}
          formatValue={(value) => `Copilot CLI ${value}%, CaseIQ ${100 - value}%`}
          measure={(handle) => {
            const handleWidth = handle.getBoundingClientRect().width;
            const leading = cliLane.current?.getBoundingClientRect().width;
            const available = (grid.current?.getBoundingClientRect().width ?? 0) - handleWidth;
            if (!handleWidth || !leading || available <= 0) return null;
            const current = measuredPairedSessionSplit(leading, available);
            return { value: current, move: (delta) => movedPairedSessionSplit(current, delta, available) };
          }}
          keyboard={keyboardPairedSessionSplit} preview={previewSplit} commit={commitSplit}>
          <GripVertical size={14} aria-hidden="true" />
        </PaneResizeHandle>}
      </Fragment>)}
    </div>
  </div>;
}
