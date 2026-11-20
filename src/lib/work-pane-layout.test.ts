import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  applyPairedSessionSplit, keyboardPairedSessionSplit, measuredPairedSessionSplit, movedPairedSessionSplit,
  PAIRED_SESSION_SPLIT_INITIALIZER, PAIRED_SESSION_SPLIT_KEY, pairedSessionSplitCssProperties, readPairedSessionSplit,
  defaultWorkPaneWidths, keyboardWorkPaneWidth, movedWorkPaneWidth, readWorkPaneWidths, workPaneCssProperties,
  workPaneLimits, WORK_PANE_WIDTHS_INITIALIZER, WORK_PANE_WIDTHS_KEY,
} from "./work-pane-layout";

describe("Work detail pane widths", () => {
  it("moves each divider in the physical pointer direction", () => {
    expect(movedWorkPaneWidth("left", 128, 104)).toBe(232);
    expect(movedWorkPaneWidth("left", 232, -104)).toBe(128);
    expect(movedWorkPaneWidth("right", 240, -100)).toBe(340);
    expect(movedWorkPaneWidth("right", 340, 100)).toBe(240);
  });

  it("clamps both sides to independent limits", () => {
    expect(movedWorkPaneWidth("left", 128, -1000)).toBe(workPaneLimits.left.min);
    expect(movedWorkPaneWidth("left", 128, 1000)).toBe(workPaneLimits.left.max);
    expect(movedWorkPaneWidth("right", 240, 1000)).toBe(workPaneLimits.right.min);
    expect(movedWorkPaneWidth("right", 240, -1000)).toBe(workPaneLimits.right.max);
  });

  it("uses the same directions and limits for accessible keyboard resizing", () => {
    expect(keyboardWorkPaneWidth("left", 128, "ArrowRight")).toBe(144);
    expect(keyboardWorkPaneWidth("right", 240, "ArrowLeft")).toBe(256);
    expect(keyboardWorkPaneWidth("right", 240, "ArrowRight")).toBe(224);
    expect(keyboardWorkPaneWidth("left", 128, "End")).toBe(workPaneLimits.left.max);
    expect(keyboardWorkPaneWidth("right", 240, "Home")).toBe(workPaneLimits.right.min);
    expect(keyboardWorkPaneWidth("left", 128, "Enter")).toBeNull();
  });

  it("restores widths safely without changing the existing defaults", () => {
    expect(readWorkPaneWidths(null)).toEqual({ left: 128, right: 240 });
    expect(readWorkPaneWidths('{"left":226,"right":341}')).toEqual({ left: 226, right: 341 });
    expect(readWorkPaneWidths('{"left":-500,"right":9999}')).toEqual({ left: 112, right: 464 });
    expect(defaultWorkPaneWidths).toEqual({ left: 128, right: 240 });
  });

  it.each(["{invalid", "null", "[]", '{"left":128}', '{"left":"128","right":240}', '{"left":1e309,"right":240}'])(
    "rejects invalid stored pane widths: %s", (value) => expect(() => readWorkPaneWidths(value)).toThrow(),
  );
});

describe("paired Session divider", () => {
  it("measures the visible ratio and moves it in either direction without exceeding its bounds", () => {
    expect(measuredPairedSessionSplit(480, 800)).toBe(60);
    expect(measuredPairedSessionSplit(0, 0)).toBe(50);
    expect(movedPairedSessionSplit(50, 80, 800)).toBe(60);
    expect(movedPairedSessionSplit(60, -80, 800)).toBe(50);
    expect(movedPairedSessionSplit(50, 300, 800)).toBe(65);
    expect(movedPairedSessionSplit(50, -300, 800)).toBe(35);
  });

  it("offers a keyboard equivalent, including an explicit reset", () => {
    expect(keyboardPairedSessionSplit(50, "ArrowRight")).toBe(52);
    expect(keyboardPairedSessionSplit(50, "ArrowLeft")).toBe(48);
    expect(keyboardPairedSessionSplit(35, "ArrowLeft")).toBe(35);
    expect(keyboardPairedSessionSplit(50, "Home")).toBe(35);
    expect(keyboardPairedSessionSplit(50, "End")).toBe(65);
    expect(keyboardPairedSessionSplit(63, "Enter")).toBe(50);
    expect(keyboardPairedSessionSplit(50, "Tab")).toBeNull();
  });

  it("applies complementary widths and clears only the comparison preview properties", () => {
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    applyPairedSessionSplit(style, 63);
    expect(style.setProperty.mock.calls).toEqual([
      [pairedSessionSplitCssProperties.cli, "63fr"], [pairedSessionSplitCssProperties.caseIq, "37fr"],
    ]);
    applyPairedSessionSplit(style, null);
    expect(style.removeProperty.mock.calls).toEqual([
      [pairedSessionSplitCssProperties.cli], [pairedSessionSplitCssProperties.caseIq],
    ]);
  });

  function initialize(value: string | null) {
    const getItem = vi.fn(() => value);
    const setProperty = vi.fn();
    const warn = vi.fn();
    runInNewContext(PAIRED_SESSION_SPLIT_INITIALIZER, {
      localStorage: { getItem },
      document: { documentElement: { style: { setProperty } } },
      console: { warn },
    });
    expect(getItem).toHaveBeenCalledWith(PAIRED_SESSION_SPLIT_KEY);
    return { setProperty, warn };
  }

  it.each(["60", "65.5", "-500", "36.8"])("restores %s before paint with the same bounds as the client", (value) => {
    const ratio = readPairedSessionSplit(value);
    const { setProperty, warn } = initialize(value);
    expect(setProperty.mock.calls).toEqual([
      [pairedSessionSplitCssProperties.cli, `${ratio}fr`], [pairedSessionSplitCssProperties.caseIq, `${100 - ratio}fr`],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["[55]", "null", '"55"', "1e309", "bad JSON"])("rejects corrupt layout preferences: %s", (value) => {
    expect(() => readPairedSessionSplit(value)).toThrow();
    const invalid = initialize(value);
    expect(invalid.setProperty).not.toHaveBeenCalled();
    expect(invalid.warn).toHaveBeenCalledOnce();
  });

  it("uses equal widths when there is no saved comparison preference", () => {
    const fresh = initialize(null);
    expect(readPairedSessionSplit(null)).toBe(50);
    expect(fresh.setProperty).not.toHaveBeenCalled();
    expect(fresh.warn).not.toHaveBeenCalled();
  });
});

describe("initial pane paint", () => {
  function initialize(value: string | null) {
    const getItem = vi.fn(() => value);
    const setItem = vi.fn();
    const setProperty = vi.fn();
    const warn = vi.fn();
    runInNewContext(WORK_PANE_WIDTHS_INITIALIZER, {
      localStorage: { getItem, setItem },
      document: { documentElement: { style: { setProperty } } },
      console: { warn },
    });
    expect(getItem).toHaveBeenCalledWith(WORK_PANE_WIDTHS_KEY);
    expect(setItem).not.toHaveBeenCalled();
    return { setProperty, warn };
  }

  it.each(['{"left":226,"right":341}', '{"left":-500,"right":9999}'])(
    "applies the same bounded saved widths before the workspace hydrates: %s", (value) => {
      const { setProperty, warn } = initialize(value);
      const widths = readWorkPaneWidths(value);
      expect(setProperty.mock.calls).toEqual([
        [workPaneCssProperties.left, `${widths.left}px`],
        [workPaneCssProperties.right, `${widths.right}px`],
      ]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("uses the CSS defaults if nothing was saved and reports invalid preferences without applying them", () => {
    const absent = initialize(null);
    expect(absent.setProperty).not.toHaveBeenCalled();
    expect(absent.warn).not.toHaveBeenCalled();
    const invalid = initialize('{"left":226,"right":"341px"}');
    expect(invalid.setProperty).not.toHaveBeenCalled();
    expect(invalid.warn).toHaveBeenCalledOnce();
  });
});
