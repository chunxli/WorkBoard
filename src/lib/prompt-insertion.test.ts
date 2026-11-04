import { describe, expect, it, vi } from "vitest";
import { insertPromptName, restorePromptSelection } from "./prompt-insertion";

describe("plain filename insertion into a Prompt", () => {
  it.each([
    ["", null, "file.txt"],
    ["Read", null, "Read file.txt"],
    ["Read", { start: 0, end: 0 }, "file.txt Read"],
    ["Readthis", { start: 4, end: 4 }, "Read file.txt this"],
    ["Read old now", { start: 5, end: 8 }, "Read file.txt now"],
    ["Read \nnext", { start: 6, end: 6 }, "Read \nfile.txt next"],
  ])("inserts at the caret or replaces the selection in %j", (prompt, selection, expected) => {
    expect(insertPromptName(prompt, "file.txt", selection)).toMatchObject({ ok: true, value: expected });
  });
  it("inserts full file/folder paths with spaces at a selection or the end", () => {
    const file = "C:\\Work\\reports\\sample [1].html";
    expect(insertPromptName("Read old now", file, { start: 5, end: 8 })).toMatchObject({
      ok: true, value: `Read ${file} now`,
    });
    expect(insertPromptName("Read", "C:\\Work\\docs", null)).toMatchObject({ ok: true, value: "Read C:\\Work\\docs" });
    const exact = insertPromptName("Read now", file, { start: 5, end: 5 });
    expect(exact).toEqual({
      ok: true, value: `Read ${file} now`, selection: { start: 6 + file.length, end: 6 + file.length },
    });
  });

  it("restores focus without page scrolling and collapses the selection at the returned caret", () => {
    const textarea = { focus: vi.fn(), setSelectionRange: vi.fn() };
    restorePromptSelection(textarea, { start: 12, end: 12 });
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(12, 12);
    expect(() => restorePromptSelection(null, { start: 0, end: 0 })).not.toThrow();
  });

  it("preserves exact Unicode, spaces, punctuation, extensions and existing boundary whitespace", () => {
    const name = "\u4e2d\u6587 report [1].txt";
    const result = insertPromptName("Read \n\t now", name, { start: 7, end: 7 });
    expect(result).toEqual({
      ok: true, value: `Read \n\t${name} now`,
      selection: { start: 7 + name.length, end: 7 + name.length },
    });
    expect(insertPromptName("", "<script>.txt", null)).toMatchObject({ value: "<script>.txt" });
    expect(insertPromptName("", "folder", null)).toMatchObject({ value: "folder" });
  });

  it("continues from the restored caret without gluing repeated names", () => {
    const first = insertPromptName("Read now", "first.txt", { start: 5, end: 5 });
    if (!first.ok) throw new Error(first.error);
    expect(insertPromptName(first.value, "second.txt", first.selection)).toEqual({
      ok: true, value: "Read first.txt second.txt now", selection: { start: 26, end: 26 },
    });
  });

  it("clamps stale selection offsets without discarding surrounding text", () => {
    expect(insertPromptName("new", "file", { start: 900, end: 1000 })).toMatchObject({ value: "new file" });
    expect(insertPromptName("new", "file", { start: -5, end: -1 })).toMatchObject({ value: "file new" });
    expect(insertPromptName("new", "file", { start: Number.NaN, end: Number.POSITIVE_INFINITY })).toMatchObject({ value: "new file" });
  });

  it("accepts the exact Prompt limit and rejects the next character without truncation", () => {
    expect(insertPromptName("a".repeat(99_998), "b", null)).toMatchObject({ ok: true, value: "a".repeat(99_998) + " b" });
    expect(insertPromptName("a".repeat(99_999), "b", null)).toMatchObject({ ok: false, error: expect.stringContaining("100,000") });
    expect(insertPromptName("a".repeat(100_000), "b", { start: 0, end: 100_000 })).toMatchObject({ ok: true, value: "b" });
    expect(insertPromptName("existing", "", null)).toMatchObject({ ok: false });
  });
});
