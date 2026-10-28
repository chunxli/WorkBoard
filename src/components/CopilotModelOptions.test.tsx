import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildModelCatalog } from "@/lib/copilot-model-catalog";
import { CopilotModelOptions, CopilotModelStatus } from "./CopilotModelOptions";

describe("account-aware model options", () => {
  const catalog = buildModelCatalog(["available", "unavailable"], [{ id: "available" }]);
  it("disables unavailable options and preserves a saved selected value", () => {
    const markup = renderToStaticMarkup(<select value="unavailable" onChange={() => {}}>
      <option value="">Auto</option><CopilotModelOptions catalog={catalog} value="unavailable" />
    </select>);
    expect(markup).toMatch(/<option[^>]*value="unavailable"[^>]*disabled=""[^>]*selected=""/);
    expect(markup).toContain("unavailable (Unavailable)");
    expect(markup).toContain('class="text-neutral-500"');
  });

  it("keeps unverified options selectable and prevents primary/fallback duplication", () => {
    const markup = renderToStaticMarkup(<select value="" onChange={() => {}}>
      <option value="">None</option><CopilotModelOptions catalog={buildModelCatalog(["a", "b"], null)} value="" exclude="a" />
    </select>);
    expect(markup).toMatch(/<option[^>]*value="a"[^>]*disabled=""/);
    expect(markup).not.toMatch(/<option[^>]*value="b"[^>]*disabled/);
    expect(markup).toContain("b (Unverified)");
  });

  it("shows failed validation and a retry action rather than an empty success state", () => {
    const markup = renderToStaticMarkup(<CopilotModelStatus catalog={null} loading={false}
      error="Could not verify model availability" refresh={vi.fn()} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not verify");
    expect(markup).toContain("Retry models");
    expect(markup).toContain('aria-label="Refresh model availability"');
  });

  it("warns about a saved unavailable selection without clearing it", () => {
    const markup = renderToStaticMarkup(<CopilotModelStatus catalog={catalog} loading={false}
      error={null} selected={["unavailable"]} refresh={vi.fn()} />);
    expect(markup).toContain("Saved model unavailable: unavailable");
  });
});
