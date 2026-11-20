"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import PaneResizeHandle from "@/components/PaneResizeHandle";
import {
  defaultWorkPaneWidths, keyboardWorkPaneWidth, movedWorkPaneWidth, readWorkPaneWidths, workPaneCssProperties,
  workPaneLimits, WORK_PANE_WIDTHS_KEY, type WorkPane, type WorkPaneWidths,
} from "@/lib/work-pane-layout";

function storedWorkPaneWidths(): WorkPaneWidths {
  try {
    return readWorkPaneWidths(window.localStorage.getItem(WORK_PANE_WIDTHS_KEY));
  } catch (error) {
    console.warn("[Work Board] Could not restore Work pane widths.", error);
    return defaultWorkPaneWidths;
  }
}

function applyWorkPaneWidths(widths: WorkPaneWidths) {
  const { style } = document.documentElement;
  style.setProperty(workPaneCssProperties.left, `${widths.left}px`);
  style.setProperty(workPaneCssProperties.right, `${widths.right}px`);
}

function WorkPaneDivider({ side, paneId, width, preview, commit }: {
  side: WorkPane;
  paneId: string;
  width: number;
  preview: (side: WorkPane, width: number | null) => void;
  commit: (side: WorkPane, width: number) => void;
}) {
  const { min, max, initial } = workPaneLimits[side];

  return <PaneResizeHandle
    className={`work-pane-divider work-pane-divider-${side}`}
    label={side === "left" ? "Resize Work sidebar" : "Resize Work files"}
    controls={paneId}
    min={min} max={max} value={width} resetValue={initial}
    formatValue={(current) => `${current} pixels`}
    measure={(handle) => {
      const displayed = handle.ownerDocument.getElementById(paneId)?.offsetWidth || width;
      return { value: displayed, move: (delta) => movedWorkPaneWidth(side, displayed, delta) };
    }}
    keyboard={(current, key) => keyboardWorkPaneWidth(side, current, key)}
    preview={(current) => preview(side, current)}
    commit={(current) => commit(side, current)}
  />;
}

export default function WorkWorkspace({ sidebar, sidebarId, files, filesId, children }: {
  sidebar: ReactNode;
  sidebarId: string;
  files: ReactNode;
  filesId: string;
  children: ReactNode;
}) {
  const hasSidebar = Boolean(sidebar);
  const [widths, setWidths] = useState(defaultWorkPaneWidths);
  const widthsRef = useRef<WorkPaneWidths | null>(null);
  const [draftWidths, setDraftWidths] = useState<Record<WorkPane, number | null>>({ left: null, right: null });

  useEffect(() => {
    if (!hasSidebar) return;
    const timer = setTimeout(() => {
      if (widthsRef.current !== null) return;
      const restored = storedWorkPaneWidths();
      applyWorkPaneWidths(restored);
      widthsRef.current = restored;
      setWidths(restored);
    }, 0);
    return () => clearTimeout(timer);
  }, [hasSidebar]);

  const preview = (side: WorkPane, width: number | null) => {
    setDraftWidths((prior) => prior[side] === width ? prior : { ...prior, [side]: width });
  };
  const commit = (side: WorkPane, width: number) => {
    const next = { ...(widthsRef.current ?? storedWorkPaneWidths()), [side]: width };
    applyWorkPaneWidths(next);
    preview(side, null);
    widthsRef.current = next;
    setWidths(next);
    try { window.localStorage.setItem(WORK_PANE_WIDTHS_KEY, JSON.stringify(next)); }
    catch (error) { console.warn("[Work Board] Could not save Work pane widths.", error); }
  };
  const left = draftWidths.left ?? widths.left;
  const right = draftWidths.right ?? widths.right;
  const style: CSSProperties & Partial<Record<(typeof workPaneCssProperties)[WorkPane], string>> = {};
  if (draftWidths.left !== null) style[workPaneCssProperties.left] = `${draftWidths.left}px`;
  if (draftWidths.right !== null) style[workPaneCssProperties.right] = `${draftWidths.right}px`;

  return <div className={hasSidebar ? `work-workspace-grid${files ? " has-files" : ""}` : undefined}
    style={hasSidebar ? style : undefined}>
    {sidebar}
    {hasSidebar && <WorkPaneDivider side="left" paneId={sidebarId} width={left} preview={preview} commit={commit} />}
    {children}
    {hasSidebar && files && <WorkPaneDivider side="right" paneId={filesId} width={right} preview={preview} commit={commit} />}
    {files}
  </div>;
}
