import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { FollowUpComposerContext } from "./FollowUpComposerContext";
import { WorkFileNavigationContext, type WorkFileLocation } from "./WorkFileNavigationContext";
import WorkFileBrowser, {
  activateNewFileHighlights,
  Directory,
  directoryPageSchema,
  discoverNewDirectoryFiles,
  finishNewFileFade,
  hasHighlightedDescendant,
  scopeHasHighlightedFiles,
  startNewFileFade,
  WorkPathReferenceButton,
  type NewFileHighlightState,
} from "./WorkFileBrowser";

const routeMocks = vi.hoisted(() => ({
  user: vi.fn(),
  workFindFirst: vi.fn(),
  runFindFirst: vi.fn(),
  listCreatedRunFiles: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: routeMocks.user }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    work: { findFirst: routeMocks.workFindFirst },
    run: { findFirst: routeMocks.runFindFirst },
  },
}));
vi.mock("@/lib/work-directory-browser", async (original) => ({
  ...await original<typeof import("@/lib/work-directory-browser")>(),
  listCreatedRunFiles: routeMocks.listCreatedRunFiles,
}));
import { GET as getWorkFilesRoute } from "@/app/api/works/[id]/files/route";

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

describe("Run completion auto-refresh and newly generated file highlights", () => {
  const pairedOutputRoot = "work-results-a794edab-8889-4898-8ba5-32c22111253f";

  it("identifies newly created user files while ignoring pre-existing entries and .workboard/.git", () => {
    const previous = new Set(["PROMPT.md", "existing.html"]);
    const current = [
      { path: ".workboard", kind: "directory" as const },
      { path: ".workboard/outputs/run-1/result.md", kind: "file" as const },
      { path: "PROMPT.md", kind: "file" as const },
      { path: "existing.html", kind: "file" as const },
      { path: "foundry-fireworks-rate-limit-followup.html", kind: "file" as const },
    ];
    expect(discoverNewDirectoryFiles(null, false, current)).toEqual([]);
    expect(discoverNewDirectoryFiles(previous, false, current)).toEqual([]);
    expect(discoverNewDirectoryFiles(previous, true, current)).toEqual([
      "foundry-fireworks-rate-limit-followup.html",
    ]);
  });

  it("marks collapsed parent folders and unselected paired location tabs that contain active new files", () => {
    const highlights = new Map<string, NewFileHighlightState>([
      ["output/report.html", "active"],
      [`${pairedOutputRoot}/caseiq/analysis.html`, "active"],
      [`${pairedOutputRoot}/copilot-cli/fading.html`, "fading"],
    ]);
    expect(hasHighlightedDescendant(highlights, "output")).toBe(true);
    expect(hasHighlightedDescendant(highlights, "docs")).toBe(false);
    expect(scopeHasHighlightedFiles(highlights, pairedOutputRoot, "shared")).toBe(true);
    expect(scopeHasHighlightedFiles(highlights, pairedOutputRoot, "CASEIQ")).toBe(true);
    expect(scopeHasHighlightedFiles(highlights, pairedOutputRoot, "CLI")).toBe(false);

    const directoryMarkup = renderToStaticMarkup(
      <Directory
        workId="work"
        directory=""
        version={0}
        highlights={highlights}
        initialEntries={[
          { name: "output", path: "output", absolutePath: "C:\\Work\\output", kind: "directory" },
          { name: "new-summary.html", path: "output/report.html", absolutePath: "C:\\Work\\output\\report.html", kind: "file" },
        ]}
      />,
    );
    expect(directoryMarkup).toContain('data-has-new-files="true"');
    expect(directoryMarkup).toContain('data-new-file="active"');
    expect(directoryMarkup).toContain("work-file-new-badge");

    const pairedMarkup = renderToStaticMarkup(
      <WorkFileBrowser
        workId="paired-work"
        pairedOutputRoot={pairedOutputRoot}
        initialHighlights={[`${pairedOutputRoot}/caseiq/analysis.html`]}
      />,
    );
    expect(pairedMarkup).toContain("work-file-scope-dot");
    expect(pairedMarkup).toContain("(new files)");
  });

  it("transitions highlighted files from active to fading on click and clears after fade completes", () => {
    const entries = [
      { name: "followup.html", path: "followup.html", absolutePath: "C:\\Work\\followup.html", kind: "file" as const },
      { name: "PROMPT.md", path: "PROMPT.md", absolutePath: "C:\\Work\\PROMPT.md", kind: "file" as const },
    ];
    const activeMap = activateNewFileHighlights(new Map(), ["followup.html", ".workboard/outputs/r1/result.md"]);
    expect([...activeMap.entries()]).toEqual([["followup.html", "active"]]);

    const activeMarkup = renderToStaticMarkup(
      <Directory workId="work" directory="" version={0} highlights={activeMap} initialEntries={entries} />,
    );
    expect(activeMarkup).toContain('title="Open followup.html in a new tab" data-new-file="active"');
    expect(activeMarkup).not.toContain('title="Open PROMPT.md in a new tab" data-new-file=');

    const fadingMap = startNewFileFade(activeMap, "followup.html");
    expect(fadingMap.get("followup.html")).toBe("fading");
    const fadingMarkup = renderToStaticMarkup(
      <Directory workId="work" directory="" version={0} highlights={fadingMap} initialEntries={entries} />,
    );
    expect(fadingMarkup).toContain('title="Open followup.html in a new tab" data-new-file="fading"');
    expect(fadingMarkup).toContain('aria-hidden="true">New</span>');

    const clearedMap = finishNewFileFade(fadingMap, "followup.html");
    expect(clearedMap.size).toBe(0);
    const clearedMarkup = renderToStaticMarkup(
      <Directory workId="work" directory="" version={0} highlights={clearedMap} initialEntries={entries} />,
    );
    expect(clearedMarkup).not.toContain("data-new-file=");
    expect(clearedMarkup).not.toContain("work-file-new-badge");
  });

  it("exposes owned Run createdPaths from /api/works/[id]/files?createdInRun and blocks active or invalid requests", async () => {
    routeMocks.user.mockResolvedValue("owner");
    routeMocks.workFindFirst.mockResolvedValue({ directoryPath: "C:\\Work" });

    const conflict = await getWorkFilesRoute(
      new NextRequest("http://localhost:3100/api/works/w1/files?open=1&createdInRun=run-1"),
      { params: Promise.resolve({ id: "w1" }) },
    );
    expect(conflict.status).toBe(400);

    routeMocks.runFindFirst.mockResolvedValueOnce({ id: "run-1", status: "RUNNING", executionPath: "C:\\Work", outputDir: null });
    const runningRes = await getWorkFilesRoute(
      new NextRequest("http://localhost:3100/api/works/w1/files?createdInRun=run-1"),
      { params: Promise.resolve({ id: "w1" }) },
    );
    expect(runningRes.status).toBe(200);
    expect(await runningRes.json()).toEqual({ createdPaths: [] });
    expect(routeMocks.listCreatedRunFiles).not.toHaveBeenCalled();

    routeMocks.runFindFirst.mockResolvedValueOnce({ id: "run-1", status: "SUCCESS", executionPath: "C:\\Work", outputDir: "C:\\Work\\.workboard\\outputs\\run-1" });
    routeMocks.listCreatedRunFiles.mockResolvedValueOnce(["output/checks.kql", "summary.html"]);
    const doneRes = await getWorkFilesRoute(
      new NextRequest("http://localhost:3100/api/works/w1/files?createdInRun=run-1"),
      { params: Promise.resolve({ id: "w1" }) },
    );
    expect(doneRes.status).toBe(200);
    expect(await doneRes.json()).toEqual({ createdPaths: ["output/checks.kql", "summary.html"] });
  });
});
