import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const db = vi.hoisted(() => ({ work: vi.fn(), parent: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  work: { findUniqueOrThrow: db.work }, run: { findFirstOrThrow: db.parent, create: db.create },
} }));
import {
  createPendingFollowUpRun,
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
  it.each(["SDK", "CLI"] as const)("persists attachments and immutable request identity for queued %s Runs", async (engine) => {
    const requestId = randomUUID(); const id = randomUUID();
    const attachments = [{ id, requestId, uploadId: randomUUID(), name: "reference.png", storedName: `${id}-reference.png`,
      size: 12, mediaType: "image/png", sha256: "0".repeat(64) }];
    db.work.mockResolvedValue({ ...work, id: "owning-work", directoryPath: "C:\\owning-work" });
    db.parent.mockResolvedValue({ ...work, engine, id: "parent-run", copilotSessionId: "same-session", executionPath: "C:\\other-execution-directory" });
    db.create.mockImplementation(async ({ data }) => data);
    const run = await createPendingFollowUpRun({ workId: "owning-work", parentRunId: "parent-run", requestId, prompt: "", attachments });
    expect(run).toMatchObject({ id: requestId, status: "PENDING", trigger: "FOLLOW_UP", engine,
      promptSnapshot: "", attachmentsJson: JSON.stringify(attachments), executionPath: "C:\\other-execution-directory", copilotSessionId: "same-session" });
    expect(run.outputDir).toContain("owning-work");
  });

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