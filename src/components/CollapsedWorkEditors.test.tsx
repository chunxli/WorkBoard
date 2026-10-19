import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PromptEditor from "./PromptEditor";
import WorkExecutionSettings from "./WorkExecutionSettings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("collapsed Work editors", () => {
  it("starts execution settings closed without unmounting the form", () => {
    const markup = renderToStaticMarkup(<WorkExecutionSettings workId="work-1" initialValue={{
      defaultEngine: "CLI", agent: "", model: "", fallbackModel: "", contextTier: "",
      reasoningEffort: "", permissionMode: "default", outputFormat: "text", timeoutSeconds: null,
    }} />);
    expect(markup).toContain("<details");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(markup).toContain("Execution settings");
    expect(markup).toContain("<form");
    expect(markup).toContain("Save settings");
  });

  it("starts Prompt closed while keeping its editable content and save status", () => {
    const markup = renderToStaticMarkup(<PromptEditor workId="work-1" promptFileName="PROMPT.md"
      initialContent="Keep this original prompt" initialHash="hash" defaultEngine="CLI"
      hasActiveConflict={false} archived={false} />);
    expect(markup).toContain("<details");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(markup).toContain("<textarea");
    expect(markup).toContain("Keep this original prompt");
    expect(markup).toContain("Saved");
    expect(markup).toContain("Run Work");
  });
});