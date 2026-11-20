export const WORK_PANE_WIDTHS_KEY = "workboard.work-pane-widths";

export const workPaneCssProperties = {
  left: "--work-sidebar-width",
  right: "--work-files-width",
} as const;

export const workPaneLimits = {
  left: { min: 112, max: 352, initial: 128 },
  right: { min: 176, max: 464, initial: 240 },
} as const;

export type WorkPane = keyof typeof workPaneLimits;
export type WorkPaneWidths = Record<WorkPane, number>;

export const defaultWorkPaneWidths: WorkPaneWidths = {
  left: workPaneLimits.left.initial,
  right: workPaneLimits.right.initial,
};

function clampWorkPaneWidth(side: WorkPane, width: number): number {
  const { min, max } = workPaneLimits[side];
  return Math.round(Math.max(min, Math.min(max, width)));
}

export function movedWorkPaneWidth(side: WorkPane, start: number, xDelta: number): number {
  return clampWorkPaneWidth(side, start + (side === "left" ? xDelta : -xDelta));
}

export function keyboardWorkPaneWidth(side: WorkPane, width: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft": return movedWorkPaneWidth(side, width, -16);
    case "ArrowRight": return movedWorkPaneWidth(side, width, 16);
    case "Home": return workPaneLimits[side].min;
    case "End": return workPaneLimits[side].max;
    default: return null;
  }
}

export function readWorkPaneWidths(stored: string | null): WorkPaneWidths {
  if (stored === null) return { ...defaultWorkPaneWidths };
  const value: unknown = JSON.parse(stored);
  if (!value || typeof value !== "object" || !("left" in value) || !("right" in value) ||
      typeof value.left !== "number" || !Number.isFinite(value.left) ||
      typeof value.right !== "number" || !Number.isFinite(value.right)) {
    throw new Error("Invalid saved Work pane widths.");
  }
  return { left: clampWorkPaneWidth("left", value.left), right: clampWorkPaneWidth("right", value.right) };
}

// Runs in the document head, before the grid can paint at its fallback widths.
export const WORK_PANE_WIDTHS_INITIALIZER = `(() => {
  try {
    const stored = localStorage.getItem(${JSON.stringify(WORK_PANE_WIDTHS_KEY)});
    if (stored === null) return;
    const widths = JSON.parse(stored);
    if (!Number.isFinite(widths?.left) || !Number.isFinite(widths?.right)) {
      throw new Error("Invalid saved Work pane widths.");
    }
    const limits = ${JSON.stringify(workPaneLimits)};
    const properties = ${JSON.stringify(workPaneCssProperties)};
    for (const side of ["left", "right"]) {
      const { min, max } = limits[side];
      const width = Math.round(Math.max(min, Math.min(max, widths[side])));
      document.documentElement.style.setProperty(properties[side], width + "px");
    }
  } catch (error) {
    console.warn("[Work Board] Could not restore Work pane widths before paint.", error);
  }
})();`;

export const PAIRED_SESSION_SPLIT_KEY = "workboard.paired-session-split";
export const pairedSessionSplitLimits = { min: 35, max: 65, initial: 50 } as const;
export const pairedSessionSplitCssProperties = {
  cli: "--work-paired-cli-share",
  caseIq: "--work-paired-caseiq-share",
} as const;

function clampPairedSessionSplit(value: number): number {
  return Math.round(Math.max(pairedSessionSplitLimits.min, Math.min(pairedSessionSplitLimits.max, value)));
}

export function movedPairedSessionSplit(start: number, deltaX: number, availableWidth: number): number {
  return clampPairedSessionSplit(availableWidth > 0 ? start + 100 * deltaX / availableWidth : start);
}

export function measuredPairedSessionSplit(cliWidth: number, availableWidth: number): number {
  return availableWidth > 0 ? clampPairedSessionSplit(100 * cliWidth / availableWidth) : pairedSessionSplitLimits.initial;
}

export function keyboardPairedSessionSplit(value: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft": return clampPairedSessionSplit(value - 2);
    case "ArrowRight": return clampPairedSessionSplit(value + 2);
    case "Home": return pairedSessionSplitLimits.min;
    case "End": return pairedSessionSplitLimits.max;
    case "Enter": return pairedSessionSplitLimits.initial;
    default: return null;
  }
}

export function readPairedSessionSplit(stored: string | null): number {
  if (stored === null) return pairedSessionSplitLimits.initial;
  const value: unknown = JSON.parse(stored);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid saved paired Session split.");
  return clampPairedSessionSplit(value);
}

export function applyPairedSessionSplit(style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">, value: number | null) {
  const { cli, caseIq } = pairedSessionSplitCssProperties;
  if (value === null) {
    style.removeProperty(cli);
    style.removeProperty(caseIq);
    return;
  }
  style.setProperty(cli, `${value}fr`);
  style.setProperty(caseIq, `${100 - value}fr`);
}

export const PAIRED_SESSION_SPLIT_INITIALIZER = `(() => {
  try {
    const stored = localStorage.getItem(${JSON.stringify(PAIRED_SESSION_SPLIT_KEY)});
    if (stored === null) return;
    const value = JSON.parse(stored);
    if (!Number.isFinite(value)) throw new Error("Invalid saved paired Session split.");
    const { min, max } = ${JSON.stringify(pairedSessionSplitLimits)};
    const ratio = Math.round(Math.max(min, Math.min(max, value)));
    const { cli, caseIq } = ${JSON.stringify(pairedSessionSplitCssProperties)};
    document.documentElement.style.setProperty(cli, ratio + "fr");
    document.documentElement.style.setProperty(caseIq, (100 - ratio) + "fr");
  } catch (error) {
    console.warn("[Work Board] Could not restore the paired Session split before paint.", error);
  }
})();`;
