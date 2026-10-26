export interface PromptSelection {
  start: number;
  end: number;
}

type PromptInsertionResult =
  | { ok: true; value: string; selection: PromptSelection }
  | { ok: false; error: string };

function offset(value: number | undefined, fallback: number, length: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback : Math.max(0, Math.min(length, Math.trunc(value)));
}

export function insertPromptName(
  prompt: string,
  name: string,
  selection: PromptSelection | null
): PromptInsertionResult {
  if (!name) return { ok: false, error: "Choose a file or folder name to insert." };
  const start = offset(selection?.start, prompt.length, prompt.length);
  const end = Math.max(start, offset(selection?.end, start, prompt.length));
  const before = prompt.slice(0, start);
  const after = prompt.slice(end);
  const leading = before && !/\s$/.test(before) && !/^\s/.test(name) ? " " : "";
  const trailing = after && !/^\s/.test(after) && !/\s$/.test(name) ? " " : "";
  const inserted = `${leading}${name}${trailing}`;
  const value = `${before}${inserted}${after}`;
  if (value.length > 100_000) {
    return { ok: false, error: "The name would exceed the 100,000-character Prompt limit." };
  }
  const caret = before.length + inserted.length;
  return { ok: true, value, selection: { start: caret, end: caret } };
}
