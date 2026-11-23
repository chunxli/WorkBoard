import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue";
import type { WorkRunSnapshot } from "./run-artifacts";
import { provisionPairedWorkspaces, verifyPairedRunDirectory } from "./work-pair-directories";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(),
  enqueue: vi.fn(), hold: vi.fn(), workExecute: vi.fn(), inspect: vi.fn(),
  workUpdate: vi.fn(), workUpdateMany: vi.fn(), finalizeArtifacts: vi.fn(), sourceDiff: vi.fn(), readCompletion: vi.fn(),
  readSnapshot: vi.fn(), variantUpdate: vi.fn(), findVariants: vi.fn(), experimentUpdate: vi.fn(),
}));
vi.mock("@/lib/prisma", () => {
  const tx = {
    run: { findMany: mocks.findMany, findUnique: mocks.findUnique, update: mocks.update, updateMany: mocks.updateMany },
    work: { update: mocks.workUpdate, updateMany: mocks.workUpdateMany },
    experimentVariant: { update: mocks.variantUpdate, findMany: mocks.findVariants },
    experiment: { updateMany: mocks.experimentUpdate },
  };
  return { prisma: { ...tx, $transaction: (fn: (value: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("@/lib/caseiq-run-lifecycle", async (original) => ({
  ...await original<typeof import("./caseiq-run-lifecycle")>(), inspectInterruptedCaseIqRun: mocks.inspect,
  readCaseIqRunCompletion: mocks.readCompletion,
}));
vi.mock("@/lib/task-executor", () => ({ executeRun: vi.fn(), finalizeAutomationRun: vi.fn() }));
vi.mock("@/lib/work-executor", async (original) => ({
  ...await original<typeof import("./work-executor")>(),
  executeWorkRun: mocks.workExecute,
  finalizeCancelledWorkRun: vi.fn(),
}));
vi.mock("@/lib/job-queue", async (original) => ({
  ...await original<typeof import("./job-queue")>(), jobQueue: { enqueue: mocks.enqueue, hold: mocks.hold },
}));
vi.mock("@/lib/run-artifacts", async (original) => ({
  ...await original<typeof import("./run-artifacts")>(),
  finalizeWorkRunArtifacts: mocks.finalizeArtifacts,
  readWorkRunSnapshot: mocks.readSnapshot,
}));
vi.mock("@/lib/work-files", () => ({ hashWorkContent: vi.fn() }));
vi.mock("@/lib/run-source-snapshot", () => ({ captureRunSourceDiff: mocks.sourceDiff }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), readdir: async () => [],
}));
import {
  CASEIQ_RECOVERY_RESERVED, interruptedCaseIqRunIds, releaseInterruptedCaseIqRun, trackInterruptedCaseIqRun,
} from "./caseiq-run-lifecycle";
import { recoverRuns, reconcileInterruptedCaseIqRuns, startCaseIqRunRecovery } from "./run-recovery";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("workBoardRecoveryStarted", false);
  mocks.finalizeArtifacts.mockResolvedValue(undefined);
  mocks.readCompletion.mockResolvedValue(null);
  mocks.readSnapshot.mockResolvedValue(null);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.findUnique.mockImplementation(async ({ where }) => {
    const records = await mocks.findMany({ where: { status: "RUNNING" } });
    return records.find(({ id }: { id: string }) => id === where.id) ?? null;
  });
});
afterEach(() => {
  for (const id of interruptedCaseIqRunIds()) releaseInterruptedCaseIqRun(id);
  vi.unstubAllGlobals();
});

describe("persisted Work queue recovery", () => {
  it("settles an archived Work's pending CaseIQ Run even when cancellation artifacts cannot be written", async () => {
    const directoryPath = await mkdtemp(path.join(tmpdir(), "workboard-archived-caseiq-"));
    const run = {
      id: randomUUID(), status: "PENDING", engine: "CASEIQ", providerId: "caseiq", workId: "archived-work",
      work: { id: "archived-work", status: "ARCHIVED", directoryPath, promptCache: "Synthetic Prompt" },
    };
    mocks.findMany.mockImplementation(async ({ where }) => where.status === "PENDING" ? [run] : []);
    mocks.findUnique.mockResolvedValue(run);
    mocks.finalizeArtifacts.mockRejectedValueOnce(new Error("Synthetic output directory failure."));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recoverRuns();
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: run.id, status: "PENDING" },
        data: expect.objectContaining({ status: "CANCELLED", finishedAt: expect.any(Date), finalOutput: "Work was archived before this run started." }),
      });
      expect(mocks.workUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: run.workId, status: { not: "ARCHIVED" } }),
      }));
      expect(mocks.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.finalizeArtifacts.mock.invocationCallOrder[0]);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.workUpdate).not.toHaveBeenCalled();
      expect(mocks.sourceDiff).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  async function completedArtifactFixture(directoryPath: string, paired = false) {
    const artifacts = await vi.importActual<typeof import("./run-artifacts")>("./run-artifacts");
    const lifecycle = await vi.importActual<typeof import("./caseiq-run-lifecycle")>("./caseiq-run-lifecycle");
    const sessionId = randomUUID();
    const sessionPair = paired ? { cliSessionId: randomUUID(), caseIqSessionId: sessionId } : null;
    const work = { id: "work", directoryPath, status: "ACTIVE", sessionPair };
    const executionPath = sessionPair ? (await provisionPairedWorkspaces(directoryPath, sessionPair)).caseIq : directoryPath;
    const id = randomUUID();
    const paths = artifacts.getWorkRunArtifactPaths(executionPath, id);
    const run = {
      id, work, workId: work.id, hostname: hostname(), copilotSessionId: sessionId, executionPath,
      engine: "CASEIQ", providerId: "caseiq", status: "RUNNING", outputDir: paths.outputDirectory,
    };
    const snapshot: WorkRunSnapshot = {
      schemaVersion: 1, runId: id, workId: work.id, workName: "Synthetic work", promptFileName: null,
      prompt: "Synthetic task", promptHash: "fixture", engine: "CASEIQ", providerId: "caseiq", sessionId: run.copilotSessionId,
      executionPath, concurrencyMode: "DIRECT", status: "SUCCESS", startedAt: "2026-11-03T00:00:00.000Z",
      finishedAt: "2026-11-03T00:00:01.000Z", exitCode: 0, errorMessage: null, gitBeforeTree: null, gitAfterTree: null,
      model: "fixture-model", inputTokens: 7, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null,
      reasoningTokens: null, modelsUsed: null,
    };
    await lifecycle.prepareCaseIqRunLaunch(run, async (folder) => { await mkdir(folder, { recursive: true }); });
    await lifecycle.authorizeCaseIqRunLaunch(run);
    await artifacts.prepareWorkRunArtifacts(executionPath, id, { ...snapshot, status: "RUNNING", finishedAt: null });
    await artifacts.finalizeWorkRunArtifacts({
      paths, snapshot, finalOutput: "Verified assistant reply", diff: "original patch",
      seal: (digests) => lifecycle.sealCaseIqRunCompletion(run, {
        artifacts: digests, hasOutput: true, finalCommit: "a".repeat(40), skillInvoked: null,
      }),
    });
    mocks.readCompletion.mockImplementation(lifecycle.readCaseIqRunCompletion);
    return { run, paths };
  }

  it.each(["verified", "changed result", "changed result after timeout", "unconfirmed exit"] as const)(
    "recovers saved CaseIQ output only from verified completion evidence (%s)", async (mode) => {
      const directory = await mkdtemp(path.join(tmpdir(), "workboard-completion-recovery-"));
      vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", path.join(directory, "private"));
      const release = vi.fn();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { run, paths } = await completedArtifactFixture(directory);
        const changed = "Verified assistant repLy\n"; // Same length; the content digest must be checked.
        const tampered = mode === "changed result" || mode === "changed result after timeout";
        const timedOut = mode === "changed result after timeout";
        if (tampered) await writeFile(paths.result, changed);
        mocks.hold.mockReturnValue(release);
        mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING" ? [run] : []);
        mocks.inspect.mockResolvedValue({ stopped: mode !== "unconfirmed exit", cancelled: false, timedOut, completedRequests: [] });
        mocks.updateMany.mockResolvedValue({ count: 1 });
        await recoverRuns();
        await reconcileInterruptedCaseIqRuns();
        if (mode === "verified") {
          expect(mocks.updateMany).toHaveBeenCalledExactlyOnceWith({
            where: { id: run.id, status: "RUNNING" },
            data: expect.objectContaining({ status: "SUCCESS", exitCode: 0, errorMessage: null, finalOutput: "Verified assistant reply",
              finishedAt: new Date("2026-11-03T00:00:01.000Z"), model: "fixture-model", inputTokens: 7, outputTokens: 3,
              finalCommit: "a".repeat(40) }),
          });
          expect(mocks.workUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "REVIEW" } }));
          expect(release).toHaveBeenCalledOnce();
        } else if (tampered) {
          expect(mocks.updateMany).toHaveBeenCalledExactlyOnceWith({
            where: { id: run.id, status: "RUNNING" },
            data: expect.objectContaining({
              status: timedOut ? "TIMED_OUT" : "FAILED", errorMessage: expect.stringContaining("could not be verified"),
            }),
          });
          expect(warning).toHaveBeenCalled();
          expect(release).toHaveBeenCalledOnce();
        } else {
          expect(mocks.readCompletion).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
        }
        expect(await readFile(paths.result, "utf8")).toBe(tampered ? changed : "Verified assistant reply\n");
        expect(await readFile(paths.diff, "utf8")).toBe("original patch");
        expect(mocks.finalizeArtifacts).not.toHaveBeenCalled();
        expect(mocks.sourceDiff).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["unavailable auxiliary files", "redirected output directory", "non-file result"] as const)(
    "recovers paired CaseIQ completion only from its original core artifacts (%s)", async (mode) => {
      const directory = await mkdtemp(path.join(tmpdir(), "workboard-paired-completion-"));
      const shared = path.join(directory, "work");
      vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", path.join(directory, "private"));
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const release = vi.fn();
      try {
        await mkdir(shared);
        const { run, paths } = await completedArtifactFixture(shared, true);
        const valid = mode === "unavailable auxiliary files";
        if (valid) {
          await mkdir(`${paths.diff}.tmp`);
          await rm(paths.transcript);
          await mkdir(paths.transcript);
          await expect(verifyPairedRunDirectory(run.work, run)).rejects.toThrow("redirected");
        } else if (mode === "redirected output directory") {
          const moved = path.join(directory, "moved-output");
          await rename(paths.outputDirectory, moved);
          await symlink(moved, paths.outputDirectory, "junction");
        } else {
          await rm(paths.result);
          await mkdir(paths.result);
        }

        mocks.hold.mockReturnValue(release);
        mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING" ? [run] : []);
        mocks.inspect.mockResolvedValue({ stopped: true, cancelled: false, timedOut: false, completedRequests: [] });
        await recoverRuns();
        await reconcileInterruptedCaseIqRuns();
        expect(mocks.updateMany).toHaveBeenCalledExactlyOnceWith({
          where: { id: run.id, status: "RUNNING" },
          data: expect.objectContaining(valid
            ? { status: "SUCCESS", finalOutput: "Verified assistant reply", inputTokens: 7, outputTokens: 3 }
            : { status: "FAILED", errorMessage: expect.stringContaining("could not be verified") }),
        });
        if (valid) expect(warning).not.toHaveBeenCalled();
        else expect(warning).toHaveBeenCalledOnce();
        expect(mocks.finalizeArtifacts).not.toHaveBeenCalled();
        expect(mocks.sourceDiff).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        warning.mockRestore();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("settles an interrupted CaseIQ experiment with no completion receipt without replaying the workspace", async () => {
    const directoryPath = await mkdtemp(path.join(tmpdir(), "workboard-recovery-prelaunch-"));
    const run = {
      id: "caseiq-not-started", workId: "work", experimentVariantId: "variant", copilotSessionId: "caseiq", status: "RUNNING",
      engine: "CASEIQ", providerId: "caseiq", work: { id: "work", directoryPath },
    };
    const release = vi.fn();
    mocks.hold.mockReturnValue(release);
    mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING" ? [run] : []);
    mocks.inspect.mockResolvedValue({ stopped: true, cancelled: false, beforeLaunch: true, completedRequests: [] });
    mocks.variantUpdate.mockResolvedValue({ experimentId: "experiment" });
    mocks.findVariants.mockResolvedValue([{ status: "FAILED" }]);
    try {
      await recoverRuns();
      await reconcileInterruptedCaseIqRuns();
      expect(mocks.sourceDiff).not.toHaveBeenCalled();
      expect(mocks.finalizeArtifacts).toHaveBeenCalledWith(expect.objectContaining({
        diff: "", snapshot: expect.objectContaining({ sourceAfterCaptured: false }),
      }));
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: run.id, status: "RUNNING" },
        data: expect.objectContaining({ status: "FAILED", errorMessage: expect.stringContaining("No Prompt was sent.") }),
      });
      expect(mocks.variantUpdate).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "variant" }, data: expect.objectContaining({ status: "FAILED" }),
      }));
      expect(mocks.experimentUpdate).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: "experiment" }), data: expect.objectContaining({ status: "COMPLETED" }),
      }));
      expect(release).toHaveBeenCalledOnce();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    } finally {
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it("rebuilds a corrupt interrupted snapshot without truncating stdout or stderr", async () => {
    const directoryPath = await mkdtemp(path.join(tmpdir(), "workboard-recovery-logs-"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const artifacts = await vi.importActual<typeof import("./run-artifacts")>("./run-artifacts");
      const work = { id: "work", directoryPath, status: "ACTIVE" };
      const run = { id: randomUUID(), work, workId: work.id, copilotSessionId: randomUUID(), executionPath: directoryPath,
        engine: "CASEIQ", providerId: "caseiq", status: "RUNNING", hostname: hostname() };
      const paths = artifacts.getWorkRunArtifactPaths(directoryPath, run.id);
      await mkdir(paths.outputDirectory, { recursive: true });
      await Promise.all([
        writeFile(paths.stdout, "Saved output before interruption\n"),
        writeFile(paths.stderr, "Saved error before interruption\n"),
        writeFile(paths.snapshot, "{broken"),
      ]);
      mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING" ? [run] : []);
      mocks.inspect.mockResolvedValue({ stopped: true, cancelled: false, completedRequests: [] });
      mocks.readSnapshot.mockImplementation(artifacts.readWorkRunSnapshot);
      mocks.finalizeArtifacts.mockImplementation(artifacts.finalizeWorkRunArtifacts);
      mocks.sourceDiff.mockResolvedValue({ afterGitTree: null, diff: "" });
      await recoverRuns();
      await reconcileInterruptedCaseIqRuns();
      expect(await readFile(paths.stdout, "utf8")).toBe("Saved output before interruption\n");
      expect(await readFile(paths.stderr, "utf8")).toBe("Saved error before interruption\n");
      expect(await readFile(paths.transcript, "utf8")).toBe("Saved output before interruption\n");
      expect(await artifacts.readWorkRunSnapshot(paths.snapshot)).toMatchObject({ runId: run.id, status: "FAILED" });
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: run.id, status: "RUNNING" }, data: expect.objectContaining({ status: "FAILED" }),
      });
    } finally {
      warning.mockRestore();
      await rm(directoryPath, { recursive: true, force: true });
    }
  });

  it("restores parent order and the shared session key, without duplicate recovery or early execution", async () => {
    const createdAt = new Date("2026-11-03T00:00:00Z");
    const work = { id: "synthetic-work", status: "ACTIVE" };
    const records = [
      { id: "second", resumedFromRunId: "first", trigger: "FOLLOW_UP", concurrencyMode: "FOLLOW_UP_QUEUED" },
      { id: "initial", resumedFromRunId: null, trigger: "WORK", concurrencyMode: "DIRECT" },
      { id: "first", resumedFromRunId: "initial", trigger: "FOLLOW_UP", concurrencyMode: "FOLLOW_UP_QUEUED" },
    ].map((run) => ({ ...run, createdAt, work, task: null, copilotSessionId: "restored-session" }));
    mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING" ? [] : records);
    const queue = new JobQueue(5);
    const gate = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const order: string[] = [];
    mocks.workExecute.mockImplementation(async (id) => {
      order.push(id);
      if (id === "initial") await gate.promise;
      if (id === "second") completed.resolve();
    });
    mocks.enqueue.mockImplementation((key, job) => queue.enqueue(key, job));
    try {
      await recoverRuns();
      await recoverRuns();
      expect(order).toEqual(["initial"]);
      expect(mocks.enqueue).toHaveBeenCalledTimes(3);
      expect(mocks.enqueue.mock.calls.map(([key]) => key)).toEqual(Array(3).fill("session:restored-session"));
      gate.resolve();
      await completed.promise;
      expect(order).toEqual(["initial", "first", "second"]);
    } finally {
      gate.resolve();
    }
  });

  it.each(["CANCELLED", "TIMED_OUT"] as const)("holds the CaseIQ queue until recovery confirms %s", async (status) => {
    const interrupted = {
      id: "caseiq-run", copilotSessionId: "caseiq", status: "RUNNING", engine: "CASEIQ", providerId: "caseiq", errorMessage: null,
    };
    const work = { status: "ACTIVE" };
    const queue = new JobQueue(1);
    mocks.enqueue.mockImplementation((key, job) => queue.enqueue(key, job));
    mocks.hold.mockImplementation((key) => queue.hold(key));
    mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING" ? [interrupted] : [
      { id: "queued-caseiq", copilotSessionId: "caseiq", createdAt: new Date(0), resumedFromRunId: "caseiq-run", work },
      { id: "other-session", copilotSessionId: "other", createdAt: new Date(1), resumedFromRunId: null, work },
    ]);
    mocks.inspect.mockResolvedValueOnce({ stopped: false, cancelled: false, timedOut: false, completedRequests: [] })
      .mockResolvedValueOnce({ stopped: true, cancelled: status === "CANCELLED", timedOut: status === "TIMED_OUT", completedRequests: [] });
    const order: string[] = [];
    mocks.workExecute.mockImplementation(async (id) => { order.push(id); });
    await recoverRuns();
    await reconcileInterruptedCaseIqRuns();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: interrupted.id, status: "RUNNING" },
      data: { errorMessage: CASEIQ_RECOVERY_RESERVED } });
    expect(order).toEqual(["other-session"]);
    await reconcileInterruptedCaseIqRuns();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: interrupted.id, status: "RUNNING" }, data: expect.objectContaining({ status }),
    });
    expect(order).toEqual(["other-session", "queued-caseiq"]);
  });

  it("restores independent pending work before a slow CaseIQ check and does not overlap background scans", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("caseIqRecoveryTimer", undefined);
    const interrupted = { id: "interrupted", copilotSessionId: "caseiq", status: "RUNNING", engine: "CASEIQ", providerId: "caseiq" };
    const work = { status: "ACTIVE" };
    const queue = new JobQueue(1);
    mocks.enqueue.mockImplementation((key, job) => queue.enqueue(key, job));
    mocks.hold.mockImplementation((key) => queue.hold(key));
    mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING" ? [interrupted] : [
      { id: "paused", copilotSessionId: "caseiq", createdAt: new Date(0), resumedFromRunId: interrupted.id, work },
      { id: "independent", copilotSessionId: "other", createdAt: new Date(1), resumedFromRunId: null, work },
    ]);
    const observing = Promise.withResolvers<void>();
    const verified = Promise.withResolvers<{ stopped: true; cancelled: true; completedRequests: [] }>();
    const resumed = Promise.withResolvers<void>();
    mocks.inspect.mockImplementation(() => {
      observing.resolve();
      return verified.promise;
    });
    const order: string[] = [];
    mocks.workExecute.mockImplementation(async (id: string) => {
      order.push(id);
      if (id === "paused") resumed.resolve();
    });
    const startup = recoverRuns();
    try {
      await expect(Promise.race([startup.then(() => "ready"), observing.promise.then(() => "checking")])).resolves.toBe("ready");
      expect(order).toEqual(["independent"]);
      expect(mocks.inspect).not.toHaveBeenCalled();

      startCaseIqRunRecovery();
      startCaseIqRunRecovery();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(interrupted);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(interrupted);
      expect(mocks.updateMany).not.toHaveBeenCalled();
      expect(order).toEqual(["independent"]);

      verified.resolve({ stopped: true, cancelled: true, completedRequests: [] });
      await resumed.promise;
      expect(order).toEqual(["independent", "paused"]);
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: interrupted.id, status: "RUNNING" }, data: expect.objectContaining({ status: "CANCELLED" }),
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      verified.resolve({ stopped: true, cancelled: true, completedRequests: [] });
      await startup;
    }
  });

  it("limits recovery to two checks, serializes checks by session, and services new sessions across ticks", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("caseIqRecoveryTimer", undefined);
    type Observation = { stopped: boolean; cancelled: boolean; completedRequests: [] };
    const stopped: Observation = { stopped: true, cancelled: true, completedRequests: [] };
    const slow = Promise.withResolvers<Observation>();
    const other = Promise.withResolvers<Observation>();
    const makeRun = (id: string, session: string) => ({
      id, copilotSessionId: session, status: "RUNNING", engine: "CASEIQ", providerId: "caseiq",
    });
    const first = makeRun("first", "shared");
    const sameSession = makeRun("same-session", "shared");
    const second = makeRun("second", "independent");
    const later = makeRun("later", "later");
    const candidates = [first, sameSession, second];
    const held = new Map<string, () => void>();
    mocks.hold.mockImplementation((key: string) => {
      const release = vi.fn();
      held.set(key, release);
      return release;
    });
    mocks.findMany.mockImplementation(async ({ where }) => where.status === "RUNNING"
      ? candidates.filter(({ id }) => !where.id || where.id.in.includes(id)) : []);
    let active = 0;
    let peak = 0;
    mocks.inspect.mockImplementation(async ({ id }) => {
      peak = Math.max(peak, ++active);
      try {
        if (id === first.id) return await slow.promise;
        if (id === second.id) return await other.promise;
        return stopped;
      } finally {
        active--;
      }
    });
    await recoverRuns();
    try {
      startCaseIqRunRecovery();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.inspect.mock.calls.map(([run]) => run.id)).toEqual([first.id, second.id]);
      expect(peak).toBe(2);
      expect(held.get("session:shared")).not.toHaveBeenCalled();

      candidates.push(later);
      trackInterruptedCaseIqRun(later);
      other.resolve(stopped);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.inspect.mock.calls.map(([run]) => run.id)).toEqual([first.id, second.id, later.id]);
      expect(held.get("session:later")).toHaveBeenCalledOnce();
      expect(held.get("session:shared")).not.toHaveBeenCalled();

      slow.resolve(stopped);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.inspect.mock.calls.map(([run]) => run.id)).toEqual([first.id, second.id, later.id, sameSession.id]);
      expect(held.get("session:shared")).toHaveBeenCalledOnce();
      expect(peak).toBe(2);
    } finally {
      slow.resolve(stopped);
      other.resolve(stopped);
      vi.clearAllTimers();
      vi.useRealTimers();
      await reconcileInterruptedCaseIqRuns();
    }
  });
});
