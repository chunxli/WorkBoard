import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(), current: vi.fn(), claim: vi.fn(), update: vi.fn(), count: vi.fn(), workUpdate: vi.fn(),
  settle: vi.fn(), workProjection: vi.fn(),
  native: vi.fn(), sdk: vi.fn(), caseiq: vi.fn(), controlled: vi.fn(), prepare: vi.fn(), finalize: vi.fn(), attachments: vi.fn(),
  baseline: vi.fn<typeof import("./run-source-snapshot").captureRunSourceBaseline>(),
  sourceDiff: vi.fn<typeof import("./run-source-snapshot").captureRunSourceDiff>(),
  insights: vi.fn(), writeSnapshot: vi.fn(),
  append: vi.fn(), nativeActive: vi.fn(), controller: vi.fn(), retain: vi.fn(),
  prepareLaunch: vi.fn(), authorizeLaunch: vi.fn(), persistPrelaunchCancellation: vi.fn(), sealCompletion: vi.fn(),
}));
vi.mock("@/lib/prisma", () => {
  const tx = { run: { updateMany: mocks.settle }, work: { updateMany: mocks.workProjection } };
  return { prisma: {
    run: { findUniqueOrThrow: mocks.find, findUnique: mocks.current, updateMany: mocks.claim, update: mocks.update, count: mocks.count },
    work: { update: mocks.workUpdate, updateMany: mocks.workProjection },
    $transaction: (callback: (database: typeof tx) => unknown) => callback(tx),
  } };
});
vi.mock("@/lib/copilot-runner", async (original) => ({
  ...await original<typeof import("./copilot-runner")>(), startCopilotRun: mocks.native, isNativeCopilotRunActive: mocks.nativeActive,
}));
vi.mock("@/lib/managed-session-controller", async (original) => ({
  ...await original<typeof import("./managed-session-controller")>(), getManagedSessionController: mocks.controller,
}));
vi.mock("@/lib/copilot-sdk-runner", () => ({
  startCopilotSdkRun: mocks.sdk, startCopilotCliControlledRun: mocks.controlled,
}));
vi.mock("@/lib/caseiq-runner", async (original) => ({
  ...await original<typeof import("./caseiq-runner")>(), startCaseIqRun: mocks.caseiq,
}));
vi.mock("@/lib/caseiq-run-lifecycle", async (original) => ({
  ...await original<typeof import("./caseiq-run-lifecycle")>(), trackInterruptedCaseIqRun: mocks.retain,
  prepareCaseIqRunLaunch: mocks.prepareLaunch, authorizeCaseIqRunLaunch: mocks.authorizeLaunch,
  persistCaseIqPrelaunchCancellation: mocks.persistPrelaunchCancellation,
  sealCaseIqRunCompletion: mocks.sealCompletion,
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
  writeRunSnapshot: mocks.writeSnapshot,
  serializeRunFinalization: async (_id: string, action: () => Promise<void>) => action(),
}));
vi.mock("@/lib/run-source-snapshot", () => ({
  captureRunSourceBaseline: mocks.baseline,
  captureRunSourceDiff: mocks.sourceDiff,
}));
vi.mock("@/lib/copilot-session-compat", () => ({ repairLegacyCopilotSessionEvents: vi.fn() }));
vi.mock("@/lib/copilot-session-insights", async (original) => ({
  ...await original<typeof import("./copilot-session-insights")>(),
  readCopilotSessionInsights: mocks.insights,
}));
import { executeWorkRun } from "./work-executor";
import { getPendingRunPreparation } from "./work-run-preparation-state";
import { ManagedSessionController } from "./managed-session-controller";
import { CaseIqRunUnconfirmedError } from "./caseiq-errors";
import { cancelRun } from "./copilot-runner";
import type { startCaseIqRun } from "./caseiq-runner";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.current.mockResolvedValue({ status: "PENDING" });
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.settle.mockResolvedValue({ count: 1 });
  mocks.baseline.mockResolvedValue(null);
  mocks.sourceDiff.mockResolvedValue({ afterGitTree: null, diff: "" });
  mocks.count.mockResolvedValue(0);
  mocks.insights.mockResolvedValue(null);
  mocks.nativeActive.mockReturnValue(false);
  mocks.controller.mockReturnValue(null);
  mocks.append.mockResolvedValue(undefined);
  mocks.attachments.mockResolvedValue([{ type: "file", path: "C:\\synthetic\\new.png", displayName: "new.png" }]);
  const result = {
    exitCode: 0, timedOut: false, cancelled: false, finalOutput: "Synthetic response",
    cpuTimeMs: null, peakMemoryMb: null, incomplete: false, usage: null, model: "primary",
  };
  mocks.native.mockResolvedValue(result);
  mocks.sdk.mockResolvedValue(result);
  mocks.caseiq.mockResolvedValue(result);
  mocks.controlled.mockImplementation(() => { throw new Error("Native CLI must not enter the SDK wrapper"); });
});
afterEach(() => { vi.useRealTimers(); });

function run(engine: "CLI" | "SDK" | "CASEIQ", resume: boolean) {
  const work = {
    id: "work", userId: "owner", name: "Synthetic work", directoryPath: "C:\\synthetic", promptFileName: "PROMPT.md",
    promptCache: "Original task", defaultEngine: engine,
  };
  return {
    id: "run", workId: work.id, work, status: "PENDING", engine,
    ...(engine === "CASEIQ" ? { providerId: "caseiq" } : {}),
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
  it("reports measured preparation before claiming a direct Run and clears it before native launch", async () => {
    const workRun = run("CLI", false);
    const observed = { ...workRun, hostname: null };
    const entered = Promise.withResolvers<void>();
    const finishSnapshot = Promise.withResolvers<null>();
    mocks.find.mockResolvedValue(workRun);
    mocks.baseline.mockImplementationOnce((_executionPath, _workDirectory, _runId, report) => {
      report?.({ filesScanned: 1, bytesRead: 130_000_000 });
      entered.resolve();
      return finishSnapshot.promise;
    });
    const execution = executeWorkRun(workRun.id);
    try {
      await Promise.race([entered.promise, execution.then(() => { throw new Error("Run finished without scanning."); })]);
      expect(getPendingRunPreparation(observed)).toEqual({
        phase: "snapshot", progress: { filesScanned: 1, bytesRead: 130_000_000 },
      });
      expect(mocks.claim).not.toHaveBeenCalled();
      expect(mocks.native).not.toHaveBeenCalled();
    } finally {
      finishSnapshot.resolve(null);
      await execution;
    }
    expect(mocks.native).toHaveBeenCalledOnce();
    expect(getPendingRunPreparation(observed)).toBeUndefined();
  });

  it("persists CaseIQ attempt versions before execution and retains them in the final Run snapshot", async () => {
    const version = { attemptId: "attempt", sourceCommit: "a".repeat(40), sourceBranch: "feature/version",
      sourceDirty: true, launcherSha256: "b".repeat(64), nativeVersion: "2.0.0" };
    mocks.find.mockResolvedValue(run("CASEIQ", false));
    mocks.caseiq.mockImplementationOnce(async (options: Parameters<typeof startCaseIqRun>[0]) => {
      await options.onVersion?.(version);
      await options.authorizeLaunch();
      return { exitCode: 0, timedOut: false, cancelled: false, finalOutput: "Synthetic response",
        cpuTimeMs: null, peakMemoryMb: null, incomplete: false, usage: null, model: "primary" };
    });
    await executeWorkRun("run");
    expect(mocks.prepareLaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "run", copilotSessionId: "native-session" }), expect.any(Function),
    );
    expect(mocks.prepareLaunch.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]);
    expect(mocks.authorizeLaunch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "run", copilotSessionId: "native-session" }));
    expect(mocks.writeSnapshot).toHaveBeenCalledWith("C:\\synthetic\\run.json",
      expect.objectContaining({ status: "RUNNING", caseIqVersions: [version] }));
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ status: "SUCCESS", caseIqVersions: [version] }),
    }));
  });

  it("keeps a CaseIQ Work reserved when owned process cleanup cannot be confirmed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.find.mockResolvedValue(run("CASEIQ", false));
      mocks.caseiq.mockRejectedValue(new CaseIqRunUnconfirmedError());
      await executeWorkRun("run");
      expect(mocks.claim).toHaveBeenCalledWith({
        where: { id: "run", status: "RUNNING" },
        data: { errorMessage: expect.stringContaining("remains reserved") },
      });
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(mocks.retain).toHaveBeenCalledWith({ id: "run", copilotSessionId: "native-session" });
      expect(logged).toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });

  it("hands sealed artifacts to recovery instead of replacing them when publishing the Work state fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.find.mockResolvedValue(run("CASEIQ", false));
      const digest = { sha256: "a".repeat(64), byteSize: 1 };
      const artifacts = { snapshot: digest, result: digest };
      mocks.finalize.mockImplementationOnce(async ({ seal }) => { await seal(artifacts); });
      mocks.workProjection.mockRejectedValueOnce(new Error("Synthetic Work projection write failed."));
      await executeWorkRun("run");
      expect(mocks.sealCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ id: "run", workId: "work", copilotSessionId: "native-session" }),
        { artifacts, hasOutput: true, finalCommit: null, skillInvoked: false },
      );
      expect(mocks.sealCompletion.mock.invocationCallOrder[0]).toBeLessThan(mocks.settle.mock.invocationCallOrder[0]);
      expect(mocks.finalize).toHaveBeenCalledOnce();
      expect(mocks.retain).toHaveBeenCalledWith({ id: "run", copilotSessionId: "native-session" });
    } finally { logged.mockRestore(); }
  });

  it.each([
    { status: "SUCCESS", exitCode: 0, cancelled: false, timedOut: false, finalOutput: "Saved response" },
    { status: "CANCELLED", exitCode: null, cancelled: true, timedOut: false, finalOutput: null },
    { status: "TIMED_OUT", exitCode: 124, cancelled: false, timedOut: true, finalOutput: null },
  ])("preserves $status when the workspace diff cannot be captured", async ({ status, ...result }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.find.mockResolvedValue(run("CASEIQ", false));
      mocks.caseiq.mockResolvedValueOnce({ ...result, usage: null, model: "primary", cpuTimeMs: null, peakMemoryMb: null, incomplete: false });
      mocks.sourceDiff.mockRejectedValueOnce(new Error("Synthetic snapshot write failure."));
      await executeWorkRun("run");
      expect(mocks.sourceDiff).toHaveBeenCalledOnce();
      expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        diff: "", finalOutput: result.finalOutput,
        snapshot: expect.objectContaining({ status, errorMessage: null, artifactWarnings: ["Workspace diff could not be collected."] }),
        seal: expect.any(Function),
      }));
      expect(mocks.settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        where: { id: "run", status: "RUNNING" },
        data: expect.objectContaining({ status, exitCode: result.exitCode, finalOutput: result.finalOutput, model: "primary" }),
      }));
      expect(mocks.update).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

  it.each(["ready", "attachment error", "record error"] as const)("waits for the durable decision before settling CaseIQ preparation cancellation (%s)", async (scenario) => {
    mocks.find.mockResolvedValue(run("CASEIQ", false));
    mocks.current.mockResolvedValueOnce({ status: "PENDING" }).mockResolvedValueOnce({ status: "PENDING" }).mockResolvedValue({ status: "RUNNING" });
    const entered = Promise.withResolvers<void>();
    const attachments = Promise.withResolvers<[]>();
    const persisting = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<void>();
    mocks.attachments.mockImplementationOnce(() => {
      entered.resolve();
      return attachments.promise;
    });
    mocks.persistPrelaunchCancellation.mockImplementationOnce(() => {
      persisting.resolve();
      return persisted.promise;
    });
    const execution = executeWorkRun("run");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await Promise.race([entered.promise, execution.then(() => { throw new Error("Run did not reach attachment preparation."); })]);
      let answered = false;
      const cancellation = cancelRun("run").catch((error: unknown) => error).finally(() => { answered = true; });
      await persisting.promise;
      if (scenario === "attachment error") attachments.reject(new Error("Attachment disappeared during cancellation."));
      else attachments.resolve([]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(answered).toBe(false);
      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(mocks.caseiq).not.toHaveBeenCalled();

      if (scenario === "record error") {
        const failure = new Error("Synthetic cancellation record write failed.");
        persisted.reject(failure);
        expect(await cancellation).toBe(failure);
        await execution;
        expect(mocks.settle).not.toHaveBeenCalled();
        expect(mocks.finalize).not.toHaveBeenCalled();
        expect(mocks.retain).toHaveBeenCalledExactlyOnceWith({ id: "run", copilotSessionId: "native-session" });
        expect(logged).toHaveBeenCalled();
      } else {
        persisted.resolve();
        expect(await cancellation).toBe(true);
        await execution;
        expect(mocks.settle).toHaveBeenCalledExactlyOnceWith({
          where: { id: "run", status: "RUNNING" },
          data: expect.objectContaining({ status: "CANCELLED", finishedAt: expect.any(Date) }),
        });
        expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ snapshot: expect.objectContaining({ status: "CANCELLED" }) }));
      }
      expect(mocks.caseiq).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    } finally {
      persisted.resolve();
      attachments.resolve([]);
      logged.mockRestore();
      await execution;
    }
  });

  it("does not publish a preparation error if a queued CaseIQ cancellation already won", async () => {
    mocks.find.mockResolvedValue(run("CASEIQ", false));
    mocks.baseline.mockRejectedValueOnce(new Error("Synthetic baseline preparation failure."));
    // The failed worker read PENDING, but cancellation committed before its conditional write.
    mocks.settle.mockResolvedValueOnce({ count: 0 });
    await executeWorkRun("run");
    expect(mocks.settle).toHaveBeenCalledExactlyOnceWith({
      where: { id: "run", status: "PENDING" },
      data: expect.objectContaining({ status: "FAILED" }),
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.caseiq).not.toHaveBeenCalled();
  });

  it("does not replace a CaseIQ cancellation snapshot when a job loses the race during launch preparation", async () => {
    mocks.find.mockResolvedValue(run("CASEIQ", false));
    mocks.current.mockResolvedValueOnce({ status: "PENDING" }).mockResolvedValue({ status: "CANCELLED" });
    await executeWorkRun("run");
    expect(mocks.prepareLaunch).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.caseiq).not.toHaveBeenCalled();
  });

  it.each(["CLI", "SDK", "CASEIQ"] as const)("executes a %s Work using only its real engine", async (engine) => {
    mocks.find.mockResolvedValue(run(engine, false));
    await executeWorkRun("run");
    const selected = engine === "CASEIQ" ? mocks.caseiq : engine === "CLI" ? mocks.native : mocks.sdk;
    expect(selected).toHaveBeenCalledOnce();
    for (const other of [mocks.native, mocks.sdk, mocks.caseiq]) if (other !== selected) expect(other).not.toHaveBeenCalled();
    expect(mocks.controlled).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "native-session", prompt: "Original task", resumeSession: false,
      ...(engine !== "SDK"
        ? { repoPath: "C:\\synthetic", attachmentPaths: ["C:\\synthetic\\new.png"] }
        : { workPath: "C:\\synthetic", attachments: [{ type: "file", path: "C:\\synthetic\\new.png", displayName: "new.png" }] }),
    }));
    if (engine === "CASEIQ") expect(selected).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", workId: "work" }));
    const saved = engine === "CASEIQ" ? mocks.settle : mocks.update;
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS" }) }));
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
