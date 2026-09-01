import { describe, expect, it } from "vitest";
import {
  automationDefaultsPayload,
  BUILT_IN_EXECUTION_DEFAULTS,
  executionDefaultsPayload,
  normalizeExecutionDefaults,
  workDefaultsPayload,
} from "./execution-defaults";
import { executionDefaultsSchema } from "./validation";

describe("execution defaults", () => {
  it("falls back to the built-in defaults when no user settings exist", () => {
    expect(normalizeExecutionDefaults(null)).toEqual(BUILT_IN_EXECUTION_DEFAULTS);
  });

  it("normalizes stored nullable values for client forms", () => {
    expect(normalizeExecutionDefaults({
      defaultEngine: "SDK",
      agent: null,
      model: "gpt-test",
      fallbackModel: null,
      contextTier: "long_context",
      reasoningEffort: "high",
      permissionMode: "full",
      outputFormat: "json",
      workTimeoutSeconds: null,
      automationTimeoutSeconds: 900,
      useSafeBranch: false,
      waitForPreviousRuns: true,
    })).toEqual({
      defaultEngine: "SDK",
      agent: "",
      model: "gpt-test",
      fallbackModel: "",
      contextTier: "long_context",
      reasoningEffort: "high",
      permissionMode: "full",
      outputFormat: "json",
      workTimeoutSeconds: null,
      automationTimeoutSeconds: 900,
      useSafeBranch: false,
      waitForPreviousRuns: true,
    });
  });

  it("maps defaults to Work and Automation creation payloads", () => {
    const value = {
      ...BUILT_IN_EXECUTION_DEFAULTS,
      agent: "reviewer",
      model: "primary",
      fallbackModel: "fallback",
      contextTier: "long_context" as const,
      reasoningEffort: "high" as const,
      permissionMode: "full" as const,
      outputFormat: "json" as const,
      workTimeoutSeconds: 300,
      automationTimeoutSeconds: 600,
      useSafeBranch: false,
      waitForPreviousRuns: true,
    };

    expect(workDefaultsPayload(value)).toEqual({
      defaultEngine: "CLI",
      agent: "reviewer",
      model: "primary",
      fallbackModel: "fallback",
      contextTier: "long_context",
      reasoningEffort: "high",
      permissionMode: "full",
      outputFormat: "json",
      timeoutSeconds: 300,
    });
    expect(automationDefaultsPayload(value)).toEqual({
      agent: "reviewer",
      model: "primary",
      fallbackModel: "fallback",
      contextTier: "long_context",
      reasoningEffort: "high",
      permissionMode: "full",
      outputFormat: "json",
      timeoutSeconds: 600,
      useSafeBranch: false,
      waitForPreviousRuns: true,
    });
    expect(executionDefaultsPayload(value).automationTimeoutSeconds).toBe(600);
    expect(executionDefaultsPayload(value).workTimeoutSeconds).toBe(300);
  });

  it("rejects a fallback without a distinct primary model", () => {
    expect(executionDefaultsSchema.safeParse({
      ...executionDefaultsPayload(BUILT_IN_EXECUTION_DEFAULTS),
      fallbackModel: "fallback",
    }).success).toBe(false);
    expect(executionDefaultsSchema.safeParse({
      ...executionDefaultsPayload(BUILT_IN_EXECUTION_DEFAULTS),
      model: "same",
      fallbackModel: "same",
    }).success).toBe(false);
  });
});
