import { describe, expect, it } from "vitest";
import { createWorkSchema, runWorkSchema, updateWorkSchema } from "./validation";

const validWork = {
  name: "Explicit settings",
  directoryPath: "C:\\work\\explicit-settings",
  prompt: "Complete this Work",
  initialization: "USE_PATH" as const,
  defaultEngine: "CLI" as const,
  agent: "coding-agent",
  model: "model-primary",
  fallbackModel: "model-fallback",
  contextTier: "long_context" as const,
  reasoningEffort: "high" as const,
  permissionMode: "full" as const,
  outputFormat: "json" as const,
  timeoutSeconds: 900,
};

describe("Work execution settings", () => {
  it("accepts all explicit Work execution settings", () => {
    expect(createWorkSchema.parse(validWork)).toMatchObject(validWork);
    expect(updateWorkSchema.parse({
      defaultEngine: "SDK",
      agent: null,
      model: null,
      fallbackModel: null,
      contextTier: "default",
      reasoningEffort: "minimal",
      permissionMode: "default",
      outputFormat: "text",
      timeoutSeconds: null,
    })).toEqual({
      defaultEngine: "SDK",
      agent: null,
      model: null,
      fallbackModel: null,
      contextTier: "default",
      reasoningEffort: "minimal",
      permissionMode: "default",
      outputFormat: "text",
      timeoutSeconds: null,
    });
  });

  it("defaults Work timeout to None and rejects invalid or per-Run overrides", () => {
    const defaults = createWorkSchema.parse({
      ...validWork,
      outputFormat: undefined,
      timeoutSeconds: undefined,
    });
    expect(defaults.outputFormat).toBe("text");
    expect(defaults.timeoutSeconds).toBeNull();
    expect(createWorkSchema.safeParse({ ...validWork, timeoutSeconds: 29 }).success).toBe(false);
    expect(updateWorkSchema.safeParse({ timeoutSeconds: 86401 }).success).toBe(false);
    expect(runWorkSchema.safeParse({ timeoutSeconds: 1800 }).success).toBe(false);
  });

  it("rejects using the primary model as its own fallback", () => {
    expect(createWorkSchema.safeParse({
      ...validWork,
      fallbackModel: validWork.model,
    }).success).toBe(false);
  });
});