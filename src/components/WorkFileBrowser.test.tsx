import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FollowUpComposerContext } from "./FollowUpComposerContext";
import { WorkFileNavigationContext, type WorkFileLocation } from "./WorkFileNavigationContext";
import WorkFileBrowser, { directoryPageSchema, WorkPathReferenceButton } from "./WorkFileBrowser";

describe("Work file locations", () => {
  const pairedOutputRoot = "work-results-a794edab-8889-4898-8ba5-32c22111253f";

  it("initially opens Shared and ties each selector to its own panel without mounting the output lists", () => {
    const markup = renderToStaticMarkup(<WorkFileBrowser workId="paired-work" pairedOutputRoot={pairedOutputRoot} />);
    expect(markup).toContain('role="tablist" aria-label="Work file locations"');
    expect(markup).toMatch(/aria-selected="true" tabindex="0">Shared<\/button>/);
    expect(markup).toMatch(/aria-selected="false" tabindex="-1">Copilot CLI<\/button>/);
    expect(markup).toMatch(/aria-selected="false" tabindex="-1">CaseIQ<\/button>/);
    expect(markup).toContain(`title="${pairedOutputRoot}/copilot-cli"`);
    expect(markup).toContain(`title="${pairedOutputRoot}/caseiq"`);
    for (const [, tab, panel] of markup.matchAll(/id="([^"]*)" aria-controls="([^"]*)"/g)) {
      expect(markup).toContain(`id="${panel}" role="tabpanel" aria-labelledby="${tab}"`);
    }
    expect(markup.match(/role="tabpanel"[^>]+hidden=""/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Shared Work files"');
    expect(markup).not.toContain('aria-label="Copilot CLI output files"');
    expect(markup).not.toContain('aria-label="CaseIQ output files"');
  });

  it("keeps the existing directory tree on single-Session Works", () => {
    const markup = renderToStaticMarkup(<WorkFileBrowser workId="ordinary-work" />);
    expect(markup).toContain('aria-label="Work directory files"');
    expect(markup).not.toContain('aria-label="Work file locations"');
    expect(markup).not.toContain('role="tabpanel"');
  });

  it("opens the location selected by the workspace and offers its return action", () => {
    const markup = renderToStaticMarkup(<WorkFileNavigationContext.Provider value={{
      location: "CASEIQ", visited: new Set<WorkFileLocation>(["CASEIQ"]), selectLocation: vi.fn(), returnToConversation: vi.fn(),
    }}>
      <WorkFileBrowser workId="paired-work" pairedOutputRoot={pairedOutputRoot} />
    </WorkFileNavigationContext.Provider>);
    expect(markup).toContain('aria-label="Back to Conversation"');
    expect(markup).toMatch(/aria-selected="true" tabindex="0">CaseIQ<\/button>/);
    expect(markup).toContain('aria-label="CaseIQ output files"');
    expect(markup).not.toContain('aria-label="Copilot CLI output files"');
  });
});

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
