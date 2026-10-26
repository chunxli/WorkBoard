import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PromptFileStrip, { type PromptDirectoryState } from "./PromptFileStrip";

const directory: PromptDirectoryState = {
  current: "C:\\synthetic\\selected-folder",
  items: [
    { name: "folder", path: "C:\\synthetic\\selected-folder\\folder", kind: "directory" },
    { name: "file with spaces.txt", path: "C:\\synthetic\\selected-folder\\file with spaces.txt", kind: "file" },
    { name: "reference", path: "C:\\synthetic\\selected-folder\\reference", kind: "reference" },
  ],
  loading: false,
  error: null,
};

function render(state = directory, disabled = false, error: string | null = null) {
  return renderToStaticMarkup(<PromptFileStrip directory={state} disabled={disabled} error={error} onInsert={() => {}} onRefresh={() => {}} />);
}

describe("compact New work Prompt file strip", () => {
  it("labels the selected source and provides non-submitting file/folder buttons in a scroll row", () => {
    const markup = render();
    expect(markup).toContain(directory.current);
    expect(markup).toContain("Selected directory");
    expect(markup).toContain('aria-label="Selected directory names"');
    expect(markup).toContain('aria-label="Refresh selected directory"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain('aria-label="Insert folder into Prompt"');
    expect(markup).toContain('aria-label="Insert file with spaces.txt into Prompt"');
    expect(markup).toContain("name reference only");
    expect(markup.match(/type="button"/g)).toHaveLength(4);
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain('type="submit"');
  });

  it("does not expose stale buttons during loading, missing-root or error states", () => {
    const loading = render({ ...directory, loading: true });
    expect(loading).toContain("Loading names...");
    expect(loading).not.toContain('aria-label="Insert ');
    expect(loading).toContain('disabled="" aria-label="Refresh selected directory"');
    expect(render({ ...directory, items: [], current: "" })).toContain("Select a Work directory to list its contents.");
    expect(render({ ...directory, items: [] })).toContain("This directory is empty.");
    const failed = render({ ...directory, error: "Permission denied" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Refresh the selected directory to retry.");
    expect(failed).not.toContain('aria-label="Insert ');
    expect(render(directory, true).match(/disabled=""/g)).toHaveLength(4);
  });

  it("renders every name as escaped text and retains visible insertion errors", () => {
    const unusual = { name: "<script>alert(1)</script>.txt", path: "C:\\synthetic\\unusual", kind: "file" as const };
    const markup = render({ ...directory, items: [unusual] }, false, "Prompt limit reached");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("Prompt limit reached");
    const many = render({ ...directory, items: Array.from({ length: 251 }, (_, index) => ({
      name: `file-${index}.txt`, path: `C:\\synthetic\\file-${index}.txt`, kind: "file",
    })) });
    expect(many.match(/type="button"/g)).toHaveLength(252);
    expect(many).toContain("Insert file-250.txt into Prompt");
  });
});
