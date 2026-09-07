import { describe, expect, it } from "vitest";
import { mergeProcessInfo } from "./ProcessInfoPanel";

describe("ProcessInfoPanel polling", () => {
  it("preserves execution settings when a telemetry response omits them", () => {
    const initial = {
      pid: 34180,
      command: "copilot --output-format text",
      cpuTimeMs: null,
      memoryMb: null,
      agent: null,
      model: "gpt-5.6-sol",
      fallbackModel: "gpt-5.6-terra",
      contextTier: "long_context",
      reasoningEffort: "max",
      permissionMode: "full",
      timeoutLabel: "None",
    };

    expect(mergeProcessInfo(initial, {
      cpuTimeMs: 118_000,
      memoryMb: 827.8,
      model: "gpt-5.6-sol",
    })).toEqual({
      ...initial,
      cpuTimeMs: 118_000,
      memoryMb: 827.8,
    });
  });
});