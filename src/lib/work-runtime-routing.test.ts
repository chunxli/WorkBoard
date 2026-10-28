import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(), current: vi.fn(), claim: vi.fn(), update: vi.fn(), count: vi.fn(), workUpdate: vi.fn(),
  native: vi.fn(), sdk: vi.fn(), controlled: vi.fn(), prepare: vi.fn(), finalize: vi.fn(), attachments: vi.fn(),
  insights: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  run: { findUniqueOrThrow: mocks.find, findUnique: mocks.current, updateMany: mocks.claim, update: mocks.update, count: mocks.count },
  work: { update: mocks.workUpdate },
} }));
vi.mock("@/lib/copilot-runner", async (original) => ({
  ...await original<typeof import("./copilot-runner")>(), startCopilotRun: mocks.native,
}));
vi.mock("@/lib/copilot-sdk-runner", () => ({
  startCopilotSdkRun: mocks.sdk, startCopilotCliControlledRun: mocks.controlled,
}));
vi.mock("@/lib/git-safety", () => ({ getHeadCommit: async () => null }));
vi.mock("@/lib/skill-events", () => ({ detectSkillInvocation: () => false }));
vi.mock("@/lib/work-attachments", () => ({
  parseWorkAttachments: () => [], runtimeWorkAttachments: mocks.attachments,
}));
vi.mock("@/lib/run-artifacts", () => ({
  prepareWorkRunArtifacts: mocks.prepare, finalizeWorkRunArtifacts: mocks.finalize,
  getWorkRunArtifactPaths: () => ({
    outputDirectory: "C:\\synthetic\\output", stdout: "C:\\synthetic\\stdout.log",
    stderr: "C:\\synthetic\\stderr.log", snapshot: "C:\\synthetic\\run.json",
  }),
  readWorkRunSnapshot: async () => null,
}));
vi.mock("@/lib/run-source-snapshot", () => ({
  captureRunSourceBaseline: async () => null,
  captureRunSourceDiff: async () => ({ afterGitTree: null, diff: "" }),
}));
vi.mock("@/lib/copilot-session-compat", () => ({ repairLegacyCopilotSessionEvents: vi.fn() }));
vi.mock("@/lib/copilot-session-insights", async (original) => ({
  ...await original<typeof import("./copilot-session-insights")>(),
  readCopilotSessionInsights: mocks.insights,
}));
import { executeWorkRun } from "./work-executor";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.current.mockResolvedValue({ status: "PENDING" });
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.count.mockResolvedValue(0);
  mocks.insights.mockResolvedValue(null);
  mocks.attachments.mockResolvedValue([{ type: "file", path: "C:\\synthetic\\new.png", displayName: "new.png" }]);
  const result = {
    exitCode: 0, timedOut: false, cancelled: false, finalOutput: "Synthetic response",
    cpuTimeMs: null, peakMemoryMb: null, incomplete: false, usage: null,
  };
  mocks.native.mockResolvedValue(result);
  mocks.sdk.mockResolvedValue(result);
  mocks.controlled.mockImplementation(() => { throw new Error("Native CLI must not enter the SDK wrapper"); });
});

function run(engine: "CLI" | "SDK", resume: boolean) {
  const work = {
    id: "work", name: "Synthetic work", directoryPath: "C:\\synthetic", promptFileName: "PROMPT.md",
    promptCache: "Original task", defaultEngine: engine,
  };
  return {
    id: "run", workId: work.id, work, status: "PENDING", engine,
    executionPath: work.directoryPath, copilotSessionId: "native-session",
    promptSnapshot: resume ? "Only the new follow-up" : "Original task",
    trigger: resume ? "FOLLOW_UP" : "WORK", resumedFromRunId: resume ? "parent" : null,
    outputFormat: "json", timeoutSeconds: null, agent: "agent", model: "primary",
    fallbackModel: "fallback", contextTier: "default", reasoningEffort: "high", permissionMode: "default",
    experimentVariantId: null, experimentVariant: null, concurrencyMode: "DIRECT",
    createdAt: new Date(), attachmentsJson: null,
  };
}
vi.mock("@/lib/work-files", () => ({
  hashWorkContent: () => "synthetic-hash", appendWorkFollowUp: async () => {},
}));

describe("Work execution engine routing", () => {
  it.each(["CLI", "SDK"] as const)("executes a %s Work using only its real engine", async (engine) => {
    mocks.find.mockResolvedValue(run(engine, false));
    await executeWorkRun("run");
    const selected = engine === "CLI" ? mocks.native : mocks.sdk;
    expect(selected).toHaveBeenCalledOnce();
    expect(engine === "CLI" ? mocks.sdk : mocks.native).not.toHaveBeenCalled();
    expect(mocks.controlled).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "native-session", prompt: "Original task", resumeSession: false,
      ...(engine === "CLI"
        ? { repoPath: "C:\\synthetic", attachmentPaths: ["C:\\synthetic\\new.png"] }
        : { workPath: "C:\\synthetic", attachments: [{ type: "file", path: "C:\\synthetic\\new.png", displayName: "new.png" }] }),
    }));
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS" }) }));
  });

  it("resumes a native CLI Work without recreating a managed SDK session", async () => {
    mocks.find.mockResolvedValue(run("CLI", true));
    await executeWorkRun("run");
    expect(mocks.native).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "native-session", prompt: "Only the new follow-up", resumeSession: true,
    }));
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.controlled).not.toHaveBeenCalled();
    expect(mocks.insights).not.toHaveBeenCalled();
  });
});
