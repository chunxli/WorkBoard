import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), enqueue: vi.fn(), workExecute: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findMany: mocks.findMany } } }));
vi.mock("@/lib/task-executor", () => ({ executeRun: vi.fn(), finalizeAutomationRun: vi.fn() }));
vi.mock("@/lib/work-executor", () => ({ executeWorkRun: mocks.workExecute, finalizeCancelledWorkRun: vi.fn() }));
vi.mock("@/lib/job-queue", async (original) => ({
  ...await original<typeof import("./job-queue")>(), jobQueue: { enqueue: mocks.enqueue },
}));
vi.mock("@/lib/run-artifacts", () => ({
  finalizeWorkRunArtifacts: vi.fn(), getWorkRunArtifactPaths: vi.fn(),
  prepareWorkRunArtifacts: vi.fn(), readWorkRunSnapshot: vi.fn(),
}));
vi.mock("@/lib/work-files", () => ({ hashWorkContent: vi.fn() }));
vi.mock("@/lib/run-source-snapshot", () => ({ captureRunSourceDiff: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readdir: async () => [], rm: vi.fn() }));
import { recoverRuns } from "./run-recovery";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("workBoardRecoveryStarted", false);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("persisted Work queue recovery", () => {
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
});
