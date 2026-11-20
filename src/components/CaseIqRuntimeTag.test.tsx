import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CaseIqRuntimeTag from "./CaseIqRuntimeTag";
import { isCaseIqRuntime } from "@/lib/runtime-provider";

describe("globally identifiable CaseIQ runtime tag", () => {
  it("uses one shared fixed-color class and an explicit text identity", () => {
    const markup = renderToStaticMarkup(<CaseIqRuntimeTag />);
    expect(markup).toContain('data-runtime="caseiq"');
    expect(markup).toContain('class="caseiq-runtime-tag"');
    expect(markup).toContain('title="Runtime: CaseIQ"');
    expect(markup).toContain(">CaseIQ</span>");
    expect(markup).not.toContain("bg-emerald");
  });
  it("distinguishes planned/default runtime from an actual execution without changing the brand", () => {
    const markup = renderToStaticMarkup(<CaseIqRuntimeTag title="Default runtime: CaseIQ" />);
    expect(markup).toContain('title="Default runtime: CaseIQ"');
    expect(markup).toContain('class="caseiq-runtime-tag"');
  });
  it.each(["CASEIQ", "CLI"])("recognizes the actual CaseIQ provider for %s execution", (engine) => {
    const runtime = { engine, providerId: "caseiq" };
    expect(isCaseIqRuntime(runtime)).toBe(true);
  });
  it("does not infer CaseIQ from an Agent name, an engine default or an unsupported provider", () => {
    const snapshots = [
      { engine: "CLI", providerId: null, agent: "caseiq" },
      { engine: "SDK", providerId: null },
      { engine: "CASEIQ", providerId: "unsupported" },
    ];
    expect(snapshots.map(isCaseIqRuntime)).toEqual([false, false, false]);
  });
});
