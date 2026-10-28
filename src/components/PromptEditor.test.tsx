import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PromptEditor from "./PromptEditor";

vi.mock("@/components/PromptTemplatePicker", () => ({ default: () => null }));

describe("Prompt run runtime", () => {
  it.each(["CLI", "SDK"] as const)("offers a per-run choice initially selecting %s", (defaultEngine) => {
    const markup = renderToStaticMarkup(<PromptEditor workId="fixture" promptFileName="PROMPT.md"
      initialContent="Synthetic task" initialHash="fixture-hash" defaultEngine={defaultEngine}
      hasActiveConflict={false} archived={false} />);
    expect(markup).toContain('aria-label="Runtime for this run"');
    expect(markup).toContain("Copilot CLI");
    expect(markup).toContain("Copilot SDK");
    expect(markup).toContain(`value="${defaultEngine}" selected=""`);
  });
});
