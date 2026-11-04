import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FollowUpComposerContext } from "./FollowUpComposerContext";
import { directoryPageSchema, WorkPathReferenceButton } from "./WorkFileBrowser";

describe("Work file path references", () => {
  const absolutePath = "C:\\Work\\docs\\report [1].html";
  it("offers an accessible non-submitting action in the same editable Work composer", () => {
    const markup = renderToStaticMarkup(
      <FollowUpComposerContext.Provider value={{ workId: "work", disabled: false, insertPath: vi.fn() }}>
        <WorkPathReferenceButton workId="work" name="report [1].html" absolutePath={absolutePath} />
      </FollowUpComposerContext.Provider>,
    );
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Insert report [1].html path into Follow Up"');
    expect(markup).toContain(absolutePath);
    expect(markup).not.toContain('disabled=""');
  });

  it.each([
    { workId: "work", disabled: true },
    { workId: "other-work", disabled: false },
  ])("blocks locked or mismatched composers: %j", (context) => {
    const markup = renderToStaticMarkup(
      <FollowUpComposerContext.Provider value={{ ...context, insertPath: vi.fn() }}>
        <WorkPathReferenceButton workId="work" name="file" absolutePath={absolutePath} />
      </FollowUpComposerContext.Provider>,
    );
    expect(markup).toContain('disabled=""');
  });

  it("does not allow references without a composer or an exposed path", () => {
    expect(renderToStaticMarkup(<WorkPathReferenceButton workId="work" name="file" absolutePath={absolutePath} />)).toContain('disabled=""');
    const markup = renderToStaticMarkup(
      <FollowUpComposerContext.Provider value={{ workId: "work", disabled: false, insertPath: vi.fn() }}>
        <WorkPathReferenceButton workId="work" name="file" absolutePath={null} />
      </FollowUpComposerContext.Provider>,
    );
    expect(markup).toContain('disabled=""');
  });

  it("validates server-native file/folder paths while keeping unsupported entries unreferenced", () => {
    const file = { name: "report.html", path: "docs/report.html", absolutePath, kind: "file" };
    expect(directoryPageSchema.safeParse({ entries: [file], nextOffset: null }).success).toBe(true);
    expect(directoryPageSchema.safeParse({ entries: [{ ...file, absolutePath: null }], nextOffset: null }).success).toBe(false);
    expect(directoryPageSchema.safeParse({ entries: [{ ...file, kind: "unsupported", absolutePath: null }], nextOffset: null }).success).toBe(true);
    expect(directoryPageSchema.safeParse({ entries: [{ ...file, kind: "directory" }], nextOffset: null }).success).toBe(true);
  });
});
