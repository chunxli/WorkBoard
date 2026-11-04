import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(), current: vi.fn(), claim: vi.fn(), update: vi.fn(), count: vi.fn(), workUpdate: vi.fn(),
  native: vi.fn(), sdk: vi.fn(), controlled: vi.fn(), prepare: vi.fn(), finalize: vi.fn(), attachments: vi.fn(),
  insights: vi.fn(),
  append: vi.fn(), nativeActive: vi.fn(), controller: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  run: { findUniqueOrThrow: mocks.find, findUnique: mocks.current, updateMany: mocks.claim, update: mocks.update, count: mocks.count },
  work: { update: mocks.workUpdate },
} }));
vi.mock("@/lib/copilot-runner", async (original) => ({
  ...await original<typeof import("./copilot-runner")>(), startCopilotRun: mocks.native, isNativeCopilotRunActive: mocks.nativeActive,
}));
vi.mock("@/lib/managed-session-controller", async (original) => ({
  ...await original<typeof import("./managed-session-controller")>(), getManagedSessionController: mocks.controller,
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
  serializeRunFinalization: async (_id: string, action: () => Promise<void>) => action(),
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
import { ManagedSessionController } from "./managed-session-controller";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.current.mockResolvedValue({ status: "PENDING" });
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.count.mockResolvedValue(0);
  mocks.insights.mockResolvedValue(null);
  mocks.nativeActive.mockReturnValue(false);
  mocks.controller.mockReturnValue(null);
  mocks.append.mockResolvedValue(undefined);
  mocks.attachments.mockResolvedValue([{ type: "file", path: "C:\\synthetic\\new.png", displayName: "new.png" }]);
  const result = {
    exitCode: 0, timedOut: false, cancelled: false, finalOutput: "Synthetic response",
    cpuTimeMs: null, peakMemoryMb: null, incomplete: false, usage: null,
  };
  mocks.native.mockResolvedValue(result);
  mocks.sdk.mockResolvedValue(result);
  mocks.controlled.mockImplementation(() => { throw new Error("Native CLI must not enter the SDK wrapper"); });
});
afterEach(() => { vi.useRealTimers(); });

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
  hashWorkContent: () => "synthetic-hash", appendWorkFollowUp: mocks.append,
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

  describe("queued Work execution", () => {
    function prepareQueued(engine: "CLI" | "SDK" = "CLI") {
      const queued = run(engine, true);
      queued.concurrencyMode = "FOLLOW_UP_QUEUED";
      const parent = { id: "parent", status: "SUCCESS", startedAt: new Date(), resumedFromRunId: null as string | null };
      mocks.find.mockResolvedValue(queued);
      mocks.current.mockImplementation(async ({ where }) => where.id === "parent" ? parent : { status: queued.status });
      mocks.claim.mockImplementation(async ({ where, data }) => {
        if (queued.status !== where.status) return { count: 0 };
        Object.assign(queued, data);
        return { count: 1 };
      });
      mocks.update.mockImplementation(async ({ data }) => Object.assign(queued, data));
      return { queued, parent };
    }

    it.each(["SUCCESS", "FAILED", "CANCELLED", "TIMED_OUT"])("resumes the same session after a %s predecessor with only the new message", async (status) => {
      const { parent } = prepareQueued();
      parent.status = status;
      await executeWorkRun("run");
      expect(mocks.native).toHaveBeenCalledOnce();
      expect(mocks.native).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Only the new follow-up", sessionId: "native-session", resumeSession: true }));
      expect(mocks.claim.mock.calls[0][0].where.status).toBe("PENDING");
      expect(mocks.claim.mock.calls[1][0].where.status).toBe("RUNNING");
      expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.append.mock.invocationCallOrder[0]);
    });

    it("waits for cancelled SDK runtime cleanup before touching Prompt or starting the next Run", async () => {
      vi.useFakeTimers();
      const { parent } = prepareQueued("SDK");
      parent.status = "CANCELLED";
      const controller = new ManagedSessionController({ send: async () => {}, abort: async () => {} });
      mocks.controller.mockImplementation((id) => id === "parent" ? controller : null);
      const execution = executeWorkRun("run");
      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.sdk).not.toHaveBeenCalled();
      mocks.controller.mockReturnValue(null);
      await vi.advanceTimersByTimeAsync(250);
      await execution;
      expect(mocks.sdk).toHaveBeenCalledOnce();
    });

    it("checks the active ancestor behind a cancelled message that never started", async () => {
      vi.useFakeTimers();
      const { queued } = prepareQueued();
      const parent = { id: "parent", status: "CANCELLED", startedAt: null, resumedFromRunId: "ancestor" };
      const ancestor = { id: "ancestor", status: "RUNNING", startedAt: new Date(), resumedFromRunId: null };
      mocks.current.mockImplementation(async ({ where }) => where.id === "parent" ? parent : where.id === "ancestor" ? ancestor : { status: queued.status });
      const execution = executeWorkRun("run");
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.native).not.toHaveBeenCalled();
      ancestor.status = "SUCCESS";
      await vi.advanceTimersByTimeAsync(250);
      await execution;
      expect(mocks.native).toHaveBeenCalledOnce();
    });

    it("does not sync or deliver a waiting message cancelled before its claim", async () => {
      vi.useFakeTimers();
      const { queued, parent } = prepareQueued();
      parent.status = "RUNNING";
      const execution = executeWorkRun("run");
      await vi.advanceTimersByTimeAsync(250);
      queued.status = "CANCELLED";
      await vi.advanceTimersByTimeAsync(250);
      await execution;
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.native).not.toHaveBeenCalled();
      expect(mocks.sdk).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }));
    });

    it("ignores duplicate callbacks after a queued Run has finished", async () => {
      const { queued } = prepareQueued();
      queued.status = "SUCCESS";
      await executeWorkRun("run");
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.native).not.toHaveBeenCalled();
    });
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
