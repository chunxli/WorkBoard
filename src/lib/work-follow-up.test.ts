import { describe, expect, it } from "vitest";
import {
  getWorkRunQueueKey,
  resolveWorkCliOutputOptions,
  resolveFollowUpExecutionSettings,
} from "./work-executor";

const work = {
  defaultEngine: "SDK" as const,
  agent: "current-agent",
  model: "current-model",
  fallbackModel: null,
  contextTier: "long_context",
  reasoningEffort: "high",
  permissionMode: "full",
  outputFormat: "text",
  timeoutSeconds: 900,
};

describe("Follow Up Run settings", () => {
  it("passes readable text through to the CLI and reserves structured continuation for JSON", () => {
    expect(resolveWorkCliOutputOptions("text")).toEqual({
      outputFormat: "text",
      maxIncompleteContinuations: 3,
    });
    expect(resolveWorkCliOutputOptions("json")).toEqual({
      outputFormat: "json",
      maxIncompleteContinuations: 3,
    });
  });

  it("inherits the direct parent Run settings without mutable Work fallbacks", () => {
    const parent = {
      engine: "CLI" as const,
      agent: null,
      model: null,
      fallbackModel: null,
      contextTier: null,
      reasoningEffort: null,
      permissionMode: "default",
      outputFormat: "json",
      timeoutSeconds: null,
    };

    expect(resolveFollowUpExecutionSettings(work, parent)).toEqual({
      engine: "CLI",
      agent: null,
      model: null,
      fallbackModel: null,
      contextTier: null,
      reasoningEffort: null,
      permissionMode: "default",
      outputFormat: "json",
      timeoutSeconds: null,
    });
  });

  it("uses Work settings for a Follow Up that starts the first session", () => {
    expect(resolveFollowUpExecutionSettings(work, null)).toMatchObject({
      engine: "SDK",
      model: "current-model",
      outputFormat: "text",
      timeoutSeconds: 900,
    });
  });

  it("serializes Follow Up Runs by Copilot session", () => {
    expect(getWorkRunQueueKey({
      id: "run-1",
      trigger: "FOLLOW_UP",
      copilotSessionId: "session-1",
    })).toBe("session:session-1");
    expect(getWorkRunQueueKey({
      id: "run-2",
      trigger: "WORK",
      copilotSessionId: "session-2",
    })).toBe("run-2");
  });
});