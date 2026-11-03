import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_EXECUTION_DEFAULTS } from "@/lib/execution-defaults";
import WorkBoard from "./WorkBoard";

const mocks = vi.hoisted(() => ({
  files: [] as { id: string; file: File; thumbnail: string | null; progress: number }[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/WorkMessageAttachments", async (original) => ({
  ...await original<typeof import("@/components/WorkMessageAttachments")>(),
  useMessageAttachments: () => ({
    files: mocks.files, add: vi.fn(), remove: vi.fn(), clear: vi.fn(), upload: vi.fn(), error: null,
  }),
}));

beforeEach(() => { mocks.files = []; });
const render = () => renderToStaticMarkup(<WorkBoard
  userId="synthetic-user" works={[]} resources={[]} shortcuts={[]}
  executionDefaults={BUILT_IN_EXECUTION_DEFAULTS} canOpenExplorer
/>);

describe("New Work Prompt attachment controls", () => {
  it.each(["CLI", "SDK"] as const)("offers both runtimes and respects the saved %s creation default", (defaultEngine) => {
    const markup = renderToStaticMarkup(<WorkBoard
      userId="synthetic-user" works={[]} resources={[]} shortcuts={[]}
      executionDefaults={{ ...BUILT_IN_EXECUTION_DEFAULTS, defaultEngine }} canOpenExplorer
    />);
    expect(markup).toContain("Copilot CLI");
    expect(markup).toContain("Copilot SDK");
    expect(markup).toContain(`value="${defaultEngine}" selected=""`);
    expect(markup).not.toContain("Fallback model (CLI)");
  });
  it("offers a multi-file picker, paste/drop guidance and all three create actions", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Choose message attachments"');
    expect(markup).toContain('type="file" multiple=""');
    expect(markup).toContain("Add files");
    expect(markup).toContain("Paste images, drop files");
    expect(markup).toContain("Create only");
    expect(markup).toContain("Create &amp; Open Terminal");
    expect(markup).toContain("Create &amp; Run");
    expect(markup).toContain("Interactive Terminal receives file paths");
    expect(markup.match(/<textarea[^>]*id="work-prompt"[^>]*>/)?.[0]).toContain("required");
  });

  it("uses a stretchable folder column and omits the redundant display-name field", () => {
    const markup = render();
    expect(markup).toContain("flex min-h-0 min-w-0 flex-col gap-4");
    expect(markup).toContain('aria-label="Root directory folders"');
    expect(markup).not.toContain("max-h-44");
    expect(markup).not.toMatch(/<label[^>]*>\s*Name\s*</);
  });

  it("allows an attachment-only Prompt and keeps selected files visible and removable", () => {
    mocks.files = [{
      id: "synthetic-draft", file: new File(["synthetic evidence"], "evidence.txt"), thumbnail: null, progress: 0,
    }];
    const markup = render();
    expect(markup.match(/<textarea[^>]*id="work-prompt"[^>]*>/)?.[0]).not.toContain("required");
    expect(markup).toContain('aria-label="Attachments to send"');
    expect(markup).toContain("evidence.txt");
    expect(markup).toContain('aria-label="Remove evidence.txt"');
  });
});

describe("Work Card quick renaming", () => {
  const work: ComponentProps<typeof WorkBoard>["works"][number] = {
    id: "synthetic-work",
    name: "Example Work",
    directoryPath: "C:\\work\\example",
    promptFileName: "PROMPT.md",
    status: "REVIEW",
    defaultEngine: "CLI",
    updatedAt: "2026-11-03T00:00:00.000Z",
    updatedAtLabel: "2026/11/3 08:00:00",
    automationCount: 0,
    latestRunStatus: "SUCCESS",
    latestRunId: null,
    latestModels: [],
    latestTokenUsage: null,
    terminalResumeState: "unavailable",
  };

  it.each([true, false])("offers an accessible rename control with local actions available=%s", (canOpenExplorer) => {
    const markup = renderToStaticMarkup(<WorkBoard
      userId="synthetic-user" works={[work]} resources={[]} shortcuts={[]}
      executionDefaults={BUILT_IN_EXECUTION_DEFAULTS} canOpenExplorer={canOpenExplorer}
    />);
    expect(markup).toContain('aria-label="Rename Example Work"');
    expect(markup).toContain('title="Rename Work"');
    expect(markup).toContain('href="/work/synthetic-work"');
    expect(markup).toContain('aria-label="Open Example Work"');
    expect(markup).toContain('aria-label="Archive Example Work"');
    expect(markup).toContain(work.directoryPath);
    expect(markup).not.toContain('aria-label="Work name"');
  });

  it("bounds cards and wraps long unbroken names instead of growing the mobile grid", () => {
    const name = "W".repeat(200);
    const markup = renderToStaticMarkup(<WorkBoard
      userId="synthetic-user" works={[{ ...work, name }]} resources={[]} shortcuts={[]}
      executionDefaults={BUILT_IN_EXECUTION_DEFAULTS} canOpenExplorer
    />);
    expect(markup).toContain("group relative flex min-h-56 min-w-0 flex-col");
    expect(markup).toContain("line-clamp-2 min-w-0 flex-1 break-words");
    expect(markup).toContain(`aria-label="Rename ${name}"`);
  });
});
