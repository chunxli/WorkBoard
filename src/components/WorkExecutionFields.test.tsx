import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import WorkExecutionFields, { DEFAULT_WORK_EXECUTION_SETTINGS, workExecutionSettingsPayload } from "./WorkExecutionFields";
import ExecutionDefaultsSettings from "./ExecutionDefaultsSettings";
import { BUILT_IN_EXECUTION_DEFAULTS } from "@/lib/execution-defaults";

describe("Work runtime display", () => {
  it("offers both runtimes and selects the built-in CLI default", () => {
    const markup = renderToStaticMarkup(<WorkExecutionFields value={DEFAULT_WORK_EXECUTION_SETTINGS} onChange={vi.fn()} />);
    expect(markup).toContain('aria-label="Work runtime"');
    expect(markup).toContain("Copilot CLI");
    expect(markup).toContain("Copilot SDK");
    expect(markup).toContain('value="CLI" selected=""');
  });

  it("selects saved SDK settings and preserves CLI-only field restrictions", () => {
    const settings = { ...DEFAULT_WORK_EXECUTION_SETTINGS, defaultEngine: "SDK" as const };
    const markup = renderToStaticMarkup(<WorkExecutionFields value={settings} onChange={vi.fn()} />);
    expect(markup).toContain("Copilot SDK");
    expect(markup).toContain("Permissions (CLI only)");
    expect(markup).toContain('value="SDK" selected=""');
    expect(workExecutionSettingsPayload(settings).defaultEngine).toBe("SDK");
  });

  it("respects the explicitly saved SDK default in Settings", () => {
    const markup = renderToStaticMarkup(<ExecutionDefaultsSettings initialValue={{ ...BUILT_IN_EXECUTION_DEFAULTS, defaultEngine: "SDK" }} />);
    expect(markup).toContain('value="SDK" selected=""');
    expect(markup).not.toContain("Legacy SDK");
  });
});
