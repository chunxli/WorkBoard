import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Work } from "@/generated/prisma/client";
import type { StartCopilotRunOptions } from "./copilot-runner";
import { getWorkRunArtifactPaths, readWorkRunSnapshot } from "./run-artifacts";
import { getDirectorySnapshotPath, readDirectorySnapshot } from "./directory-snapshot";
import * as sourceSnapshot from "./run-source-snapshot";
import * as workAttachments from "./work-attachments";
import { canonicalizeWorkPath, provisionWorkDirectory } from "./work-files";
import { pairedWorkspacePath, assertPairedInputDirectory } from "./work-pair-directories";
import { pairedWorkReceipt, type PairedWorkFollowUp } from "./work-session-pair";
import { QUEUED_FOLLOW_UP_MODE } from "./work-run-queue";

const mocks = vi.hoisted(() => ({
  db: undefined as PrismaClient | undefined,
  enqueue: vi.fn<(key: string, job: () => Promise<void>) => void>(),
  cli: vi.fn(),
  caseiq: vi.fn(),
  installation: vi.fn(),
  active: vi.fn(),
  history: vi.fn(),
  binding: vi.fn(),
  authBlocked: vi.fn(),
  inspectInterrupted: vi.fn(),
  hold: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.db; } }));
vi.mock("@/lib/job-queue", async (original) => ({
  ...await original<typeof import("./job-queue")>(),
  jobQueue: { enqueue: mocks.enqueue, hold: mocks.hold },
}));
vi.mock("@/lib/caseiq-installation", () => ({ getCaseIqInstallation: mocks.installation, getCaseIqPromptPowerShell: async () => "synthetic-pwsh" }));
vi.mock("@/lib/caseiq-integration", () => ({ ensurePrivateRuntimeDirectory: (directory: string) => mkdir(directory, { recursive: true }) }));
vi.mock("@/lib/caseiq-run-lifecycle", async (original) => ({
  ...await original<typeof import("./caseiq-run-lifecycle")>(),
  inspectInterruptedCaseIqRun: mocks.inspectInterrupted,
}));
vi.mock("@/lib/caseiq-runner", () => ({ startCaseIqRun: mocks.caseiq }));
vi.mock("@/lib/copilot-runner", async (original) => ({
  ...await original<typeof import("./copilot-runner")>(), startCopilotRun: mocks.cli,
  isNativeCopilotRunActive: () => false,
}));
vi.mock("@/lib/copilot-session-compat", async (original) => ({
  ...await original<typeof import("./copilot-session-compat")>(), copilotSessionHasHistory: mocks.history,
  repairLegacyCopilotSessionEvents: async () => {},
}));
vi.mock("@/lib/native-session-bindings", () => ({
  readNativeSessionBindingSync: mocks.binding, nativeSessionBindingHome: (value: { home: string | null }) => value.home,
}));
vi.mock("@/lib/terminal-resume", () => ({ getTerminalSessionActivity: mocks.active }));
vi.mock("@/lib/caseiq-authentication-state", () => ({ caseIqAuthenticationBlockedReason: mocks.authBlocked }));

import { sendPairedFollowUp, startPairedWork } from "./work-pair-execution";
import { cancelPendingCaseIqWorkRun, createPendingWorkRun, executeWorkRun, finalizeCancelledWorkRun, settleCaseIqWorkRun } from "./work-executor";
import { releaseInterruptedCaseIqRun } from "./caseiq-run-lifecycle";
import { cancelRun } from "./copilot-runner";
import { reconcileInterruptedCaseIqRuns } from "./run-recovery";

let fixtureRoot: string;
let db: PrismaClient;
let work: Work;
let installation: string;
const prompt = "Shared synthetic Prompt";

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "workboard-pair-db-"));
  const url = `file:${path.join(fixtureRoot, "fixture.db")}`;
  execFileSync(process.execPath, [path.join(process.cwd(), "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url }, stdio: "pipe", timeout: 20_000,
  });
  db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  mocks.db = db;
  installation = await mkdtemp(path.join(fixtureRoot, "caseiq-installation-"));
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", path.join(fixtureRoot, "private"));
}, 25_000);

afterAll(async () => {
  await db?.$disconnect();
  vi.unstubAllEnvs();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.resetAllMocks();
  const owner = await db.user.create({ data: {} });
  const workId = randomUUID();
  const directoryPath = path.join(fixtureRoot, workId);
  const disk = await provisionWorkDirectory({ workId, name: "Synthetic Work", directoryPath, prompt });
  work = await db.work.create({ data: { id: workId, userId: owner.id, name: disk.name, hostname: hostname(),
    directoryPath, canonicalPath: disk.canonicalPath, promptFileName: disk.promptFileName, promptCache: prompt, promptHash: disk.promptHash } });
  mocks.installation.mockResolvedValue({ root: installation });
  mocks.active.mockResolvedValue({ active: false, starting: false });
  mocks.history.mockResolvedValue(true);
  mocks.authBlocked.mockResolvedValue(null);
});

async function initial() {
  const { runs } = pairedWorkReceipt.parse(await startPairedWork(work.userId, work.id));
  const cli = runs.find((run) => run.lane === "CLI")!;
  const caseiq = runs.find((run) => run.lane === "CASEIQ")!;
  const pair = { cliSessionId: cli.sessionId, caseIqSessionId: caseiq.sessionId };
  mocks.binding.mockImplementation((sessionId: string) => sessionId === caseiq.sessionId ? ({
    userId: work.userId, workId: work.id, home: path.join(fixtureRoot, "synthetic-caseiq-home"),
    workingDirectory: pairedWorkspacePath(work.directoryPath, pair, "CASEIQ"),
  }) : null);
  const followUp: PairedWorkFollowUp = {
    action: "follow-up", requestId: randomUUID(), prompt: "Same Follow Up", attachmentIds: [],
    targets: runs.map((run) => ({ lane: run.lane, expectedParentRunId: run.runId })),
  };
  return { cli, caseiq, pair, followUp };
}

describe("paired Work admission and execution using isolated SQLite", () => {
  it("preserves a claimed CaseIQ cancellation and its queue hold when settlement rolls back", async () => {
    const experiment = await db.experiment.create({
      data: { workId: work.id, name: "Synthetic experiment", engine: "CASEIQ", status: "RUNNING", variants: { create: { status: "READY" } } },
      include: { variants: true },
    });
    const variantId = experiment.variants[0].id;
    const run = await createPendingWorkRun({
      workId: work.id, engine: "CASEIQ", executionPath: work.directoryPath, prompt, concurrencyMode: "DIRECT",
      trigger: "EXPERIMENT", experimentVariantId: variantId,
    });
    await db.work.update({ where: { id: work.id }, data: { status: "REVIEW" } });
    const release = vi.fn();
    mocks.hold.mockReturnValue(release);
    const lifecycle = await vi.importActual<typeof import("./caseiq-run-lifecycle")>("./caseiq-run-lifecycle");
    mocks.inspectInterrupted.mockImplementation(lifecycle.inspectInterruptedCaseIqRun);
    const entered = Promise.withResolvers<void>();
    const attachments = Promise.withResolvers<[]>();
    const prepareAttachments = vi.spyOn(workAttachments, "runtimeWorkAttachments").mockImplementationOnce(() => {
      entered.resolve();
      return attachments.promise;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.$executeRaw`CREATE TRIGGER reject_claimed_caseiq_cancel_fixture BEFORE UPDATE OF status ON Work
      WHEN NEW.status = 'ACTIVE'
      BEGIN SELECT RAISE(ABORT, 'synthetic claimed cancellation projection failure'); END`;
    const execution = executeWorkRun(run.id);
    try {
      try {
        await Promise.race([entered.promise, execution.then(() => { throw new Error("Run did not reach attachment preparation."); })]);
        expect(await cancelRun(run.id)).toBe(true);
        attachments.resolve([]);
        await execution;
        expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "RUNNING", finishedAt: null });
        expect(await db.experimentVariant.findUniqueOrThrow({ where: { id: variantId } })).toMatchObject({ status: "RUNNING" });
        expect(await db.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({ status: "RUNNING", finishedAt: null });
        expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status: "REVIEW" });
        expect(mocks.hold).toHaveBeenCalledExactlyOnceWith(`session:${run.copilotSessionId}`);
        expect(release).not.toHaveBeenCalled();
      } finally {
        await db.$executeRaw`DROP TRIGGER reject_claimed_caseiq_cancel_fixture`;
      }
      await reconcileInterruptedCaseIqRuns();
      expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "CANCELLED", finishedAt: expect.any(Date), errorMessage: expect.stringContaining("No Prompt was sent."),
      });
      expect(await db.experimentVariant.findUniqueOrThrow({ where: { id: variantId } })).toMatchObject({ status: "CANCELLED" });
      expect(await db.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({ status: "COMPLETED" });
      expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status: "ACTIVE" });
      expect(mocks.caseiq).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      attachments.resolve([]);
      try { await execution; } finally {
        prepareAttachments.mockRestore();
        logged.mockRestore();
        releaseInterruptedCaseIqRun(run.id);
      }
    }
  });

  it("rolls back all CaseIQ projections when the Work write fails and recovers the saved result without replay", async () => {
    const experiment = await db.experiment.create({
      data: { workId: work.id, name: "Synthetic experiment", engine: "CASEIQ", status: "RUNNING", variants: { create: { status: "READY" } } },
      include: { variants: true },
    });
    const variantId = experiment.variants[0].id;
    const run = await createPendingWorkRun({
      workId: work.id, engine: "CASEIQ", executionPath: work.directoryPath, prompt, concurrencyMode: "DIRECT",
      trigger: "EXPERIMENT", experimentVariantId: variantId,
    });
    mocks.caseiq.mockResolvedValue({
      exitCode: 0, finalOutput: "Saved CaseIQ result", usage: null, model: "synthetic-model", cpuTimeMs: null, peakMemoryMb: null,
    });
    const release = vi.fn();
    mocks.hold.mockReturnValue(release);
    mocks.inspectInterrupted.mockResolvedValue({ stopped: true, cancelled: false, timedOut: false, completedRequests: [] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.$executeRaw`CREATE TRIGGER reject_caseiq_work_fixture BEFORE UPDATE OF status ON Work
      WHEN NEW.status = 'REVIEW'
      BEGIN SELECT RAISE(ABORT, 'synthetic Work projection failure'); END`;
    try {
      try {
        await executeWorkRun(run.id);
        expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
          status: "RUNNING", finishedAt: null, finalOutput: null,
        });
        expect(await db.experimentVariant.findUniqueOrThrow({ where: { id: variantId } })).toMatchObject({ status: "RUNNING" });
        expect(await db.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({ status: "RUNNING", finishedAt: null });
        expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status: "ACTIVE" });
        expect(mocks.hold).toHaveBeenCalledWith(`session:${run.copilotSessionId}`);
        expect(release).not.toHaveBeenCalled();
        expect(logged).toHaveBeenCalled();
      } finally {
        await db.$executeRaw`DROP TRIGGER reject_caseiq_work_fixture`;
      }

      await reconcileInterruptedCaseIqRuns();
      expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "SUCCESS", finalOutput: "Saved CaseIQ result", errorMessage: null,
      });
      expect(await db.experimentVariant.findUniqueOrThrow({ where: { id: variantId } })).toMatchObject({ status: "SUCCESS" });
      expect(await db.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({ status: "COMPLETED" });
      expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status: "REVIEW" });
      expect(mocks.caseiq).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
      releaseInterruptedCaseIqRun(run.id);
    }
  });

  it.each(["ARCHIVED", "REVIEW"] as const)("preserves the %s Work state on settlement when it should not be projected", async (status) => {
    const { cli, caseiq } = await initial();
    const archivedAt = status === "ARCHIVED" ? new Date() : null;
    await db.work.update({ where: { id: work.id }, data: { status, archivedAt } });
    await db.run.update({ where: { id: cli.runId }, data: { status: status === "ARCHIVED" ? "SUCCESS" : "PENDING" } });
    const run = await db.run.update({ where: { id: caseiq.runId }, data: { status: "RUNNING" } });
    await settleCaseIqWorkRun(run, { status: "FAILED", finishedAt: new Date(), errorMessage: "Synthetic interruption" });
    expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "FAILED" });
    expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status, archivedAt });
  });

  it("keeps a queued CaseIQ experiment cancellable if a related write fails", async () => {
    const experiment = await db.experiment.create({
      data: { workId: work.id, name: "Synthetic experiment", engine: "CASEIQ", status: "RUNNING", variants: { create: { status: "READY" } } },
      include: { variants: true },
    });
    const variantId = experiment.variants[0].id;
    const run = await createPendingWorkRun({
      workId: work.id, engine: "CASEIQ", executionPath: work.directoryPath, prompt, concurrencyMode: "DIRECT",
      trigger: "EXPERIMENT", experimentVariantId: variantId,
    });
    await db.work.update({ where: { id: work.id }, data: { status: "REVIEW" } });
    const paths = getWorkRunArtifactPaths(work.directoryPath, run.id);
    const message = "Synthetic cancellation before launch.";
    await db.$executeRaw`CREATE TRIGGER reject_caseiq_cancel_fixture BEFORE UPDATE OF status ON Work
      WHEN NEW.status = 'ACTIVE'
      BEGIN SELECT RAISE(ABORT, 'synthetic cancellation projection failure'); END`;
    try {
      await expect(cancelPendingCaseIqWorkRun(run.id, message)).rejects.toThrow();
      expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "PENDING", finishedAt: null, finalOutput: null,
      });
      expect(await db.experimentVariant.findUniqueOrThrow({ where: { id: variantId } })).toMatchObject({ status: "READY" });
      expect(await db.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({ status: "RUNNING", finishedAt: null });
      expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status: "REVIEW" });
      await expect(readFile(paths.snapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await db.$executeRaw`DROP TRIGGER reject_caseiq_cancel_fixture`;
    }

    await expect(cancelPendingCaseIqWorkRun(run.id, message)).resolves.toBe(true);
    await executeWorkRun(run.id);
    expect(await db.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "CANCELLED", startedAt: null, finishedAt: expect.any(Date), finalOutput: message,
    });
    expect(await db.experimentVariant.findUniqueOrThrow({ where: { id: variantId } })).toMatchObject({ status: "CANCELLED", errorMessage: null });
    expect(await db.experiment.findUniqueOrThrow({ where: { id: experiment.id } })).toMatchObject({ status: "COMPLETED" });
    expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status: "ACTIVE" });
    expect(JSON.parse(await readFile(paths.snapshot, "utf8"))).toMatchObject({ status: "CANCELLED", startedAt: null });
    expect(mocks.caseiq).not.toHaveBeenCalled();
  });

  it("does not reopen an archived paired Work when its last pending Run is the CLI lane", async () => {
    const { cli, caseiq } = await initial();
    const archivedAt = new Date();
    await db.work.update({ where: { id: work.id }, data: { status: "ARCHIVED", archivedAt } });
    await expect(cancelPendingCaseIqWorkRun(caseiq.runId, "Synthetic archived Work.")).resolves.toBe(true);
    await finalizeCancelledWorkRun(cli.runId, "Synthetic archived Work.");
    expect(await db.run.count({ where: { workId: work.id, status: "CANCELLED" } })).toBe(2);
    expect(await db.work.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({ status: "ARCHIVED", archivedAt });
  });

  it("does not count the previous CaseIQ Run's changes in a Follow Up after final source capture fails", async () => {
    const { caseiq, pair, followUp } = await initial();
    const cwd = pairedWorkspacePath(work.directoryPath, pair, "CASEIQ");
    const previousFile = "previous-run.txt";
    const nextFile = "next-run.txt";
    const capture = vi.spyOn(sourceSnapshot, "captureRunSourceDiff").mockRejectedValueOnce(new Error("Synthetic final snapshot failure."));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = { exitCode: 0, finalOutput: "Synthetic response", usage: null, model: null, cpuTimeMs: null, peakMemoryMb: null };
    mocks.caseiq.mockImplementationOnce(async () => {
      await writeFile(path.join(cwd, previousFile), "The original Run created this");
      return result;
    }).mockImplementationOnce(async () => {
      await writeFile(path.join(cwd, nextFile), "The Follow Up created this");
      return result;
    });
    try {
      await executeWorkRun(caseiq.runId);
      expect(await readWorkRunSnapshot(getWorkRunArtifactPaths(cwd, caseiq.runId).snapshot)).toMatchObject({
        status: "SUCCESS", sourceAfterCaptured: false,
      });
      const savedBaseline = await readDirectorySnapshot(getDirectorySnapshotPath(cwd, caseiq.runId));
      expect(savedBaseline.entries[previousFile]).toBeUndefined();

      const { runs: [next] } = await sendPairedFollowUp(work.userId, work.id, {
        ...followUp, targets: [{ lane: "CASEIQ", expectedParentRunId: caseiq.runId }],
      });
      await executeWorkRun(next.runId);
      const artifacts = getWorkRunArtifactPaths(cwd, next.runId);
      const patch = await readFile(artifacts.diff, "utf8");
      expect(patch).toContain(nextFile);
      expect(patch).not.toContain(previousFile);
      expect(await readWorkRunSnapshot(artifacts.snapshot)).toMatchObject({ status: "SUCCESS", sourceAfterCaptured: true });
    } finally {
      capture.mockRestore();
      warning.mockRestore();
    }
  });

  it("uses the same saved Prompt and attachment in both Runs, with distinct queue keys and real output roots", async () => {
    expect(await db.workSessionPair.findUnique({ where: { workId: work.id } })).toBeNull();
    const file = await workAttachments.saveWorkAttachment({
      work, requestId: work.id, uploadId: randomUUID(), name: "input.txt", size: 0, body: null,
    });
    await workAttachments.resolveWorkAttachments(work, work.id, [file.id], true);
    await writeFile(path.join(work.directoryPath, "shared.txt"), "common input");
    const { cli, caseiq, pair, followUp } = await initial();
    expect(await db.workSessionPair.findUnique({ where: { workId: work.id } })).toMatchObject(pair);
    expect(cli.sessionId).not.toBe(caseiq.sessionId);
    expect(mocks.enqueue.mock.calls.map(([key]) => key)).toEqual([`session:${cli.sessionId}`, `session:${caseiq.sessionId}`]);
    const runNative = (label: string) => async (options: StartCopilotRunOptions) => {
      expect(options.prompt).toBe(prompt);
      expect(options.attachmentPaths).toHaveLength(1);
      expect(await readFile(options.attachmentPaths![0], "utf8")).toBe("");
      expect(options.pairedWorkspace?.inputDirectory).toBe(work.directoryPath);
      expect(await readFile(path.join(options.pairedWorkspace!.inputDirectory, "shared.txt"), "utf8")).toBe("common input");
      const instruction = await readFile(path.join(options.pairedWorkspace!.instructionDirectory, "workboard-paired.instructions.md"), "utf8");
      expect(instruction).toContain(JSON.stringify(options.repoPath));
      await writeFile(path.join(options.repoPath, `${label}.txt`), label);
      return { exitCode: 0, finalOutput: label, usage: null, model: null, cpuTimeMs: null, peakMemoryMb: null };
    };
    mocks.cli.mockImplementation(runNative("cli-generated"));
    mocks.caseiq.mockImplementation(runNative("caseiq-generated"));
    await Promise.all(mocks.enqueue.mock.calls.map(([, execute]) => execute()));
    for (const [run, label, other] of [[cli, "cli-generated", "caseiq-generated"], [caseiq, "caseiq-generated", "cli-generated"]] as const) {
      const cwd = pairedWorkspacePath(work.directoryPath, pair, run.lane);
      const artifact = getWorkRunArtifactPaths(cwd, run.runId);
      expect(await db.run.findUnique({ where: { id: run.runId } })).toMatchObject({
        status: "SUCCESS", engine: run.lane, executionPath: cwd, outputDir: artifact.outputDirectory,
        copilotSessionId: run.sessionId, promptSnapshot: prompt,
      });
      expect(await readFile(path.join(cwd, `${label}.txt`), "utf8")).toBe(label);
      const patch = await readFile(artifact.diff, "utf8");
      expect(patch).toContain(`${label}.txt`);
      expect(patch).not.toContain(`${other}.txt`);
    }

    await writeFile(path.join(pairedWorkspacePath(work.directoryPath, pair, "CASEIQ"), "between-runs.txt"), "A manual change after the parent Run");
    const sharedFollowUpFile = await workAttachments.saveWorkAttachment({
      work, requestId: followUp.requestId, uploadId: randomUUID(), name: "follow-up.txt", size: 0, body: null,
    });
    followUp.attachmentIds = [sharedFollowUpFile.id];
    const result = await sendPairedFollowUp(work.userId, work.id, followUp);
    expect(result.runs).toHaveLength(2);
    expect(result.runs.every((run) => !run.queued)).toBe(true);
    expect(await sendPairedFollowUp(work.userId, work.id, followUp)).toMatchObject({ runs: expect.arrayContaining(result.runs) });
    await expect(sendPairedFollowUp(work.userId, work.id, { ...followUp, targets: followUp.targets.slice(0, 1) }))
      .rejects.toThrow("different paired message");
    expect(await db.run.count({ where: { workId: work.id } })).toBe(4);
    expect(mocks.enqueue).toHaveBeenCalledTimes(4);
    const resumeNative = (label: string, sessionId: string) => async (options: StartCopilotRunOptions) => {
      expect(options).toMatchObject({ prompt: followUp.prompt, resumeSession: true, sessionId });
      expect(options.attachmentPaths).toHaveLength(1);
      expect(path.basename(options.attachmentPaths![0])).toBe(sharedFollowUpFile.storedName);
      await writeFile(path.join(options.repoPath, `${label}-next.txt`), "Synthetic follow-up result");
      return { exitCode: 0, finalOutput: label, usage: null, model: null, cpuTimeMs: null, peakMemoryMb: null };
    };
    mocks.cli.mockImplementation(resumeNative("cli-generated", cli.sessionId));
    mocks.caseiq.mockImplementation(resumeNative("caseiq-generated", caseiq.sessionId));
    await Promise.all(mocks.enqueue.mock.calls.slice(2).map(([, execute]) => execute()));
    for (const [lane, label] of [["CLI", "cli-generated"], ["CASEIQ", "caseiq-generated"]] as const) {
      const run = result.runs.find((run) => run.lane === lane)!;
      const artifact = getWorkRunArtifactPaths(pairedWorkspacePath(work.directoryPath, pair, lane), run.runId);
      expect(await db.run.findUnique({ where: { id: run.runId } })).toMatchObject({ status: "SUCCESS", copilotSessionId: run.sessionId });
      const patch = await readFile(artifact.diff, "utf8");
      expect(patch).toContain(`${label}-next.txt`);
      expect(patch).not.toContain(`${label}.txt`);
      if (lane === "CASEIQ") expect(patch).toContain("between-runs.txt");
    }
    expect(await readFile(path.join(work.directoryPath, work.promptFileName), "utf8")).toBe(prompt);
  }, 15_000);

  it("admits a mixed busy/idle broadcast, preserves independent FIFO, and only cancels the requested Run", async () => {
    const { cli, caseiq, pair, followUp } = await initial();
    await db.run.update({ where: { id: caseiq.runId }, data: { status: "SUCCESS", startedAt: new Date(), finishedAt: new Date() } });
    const { runs } = await sendPairedFollowUp(work.userId, work.id, followUp);
    const waiting = runs.find((run) => run.lane === "CLI")!;
    expect(waiting.queued).toBe(true);
    expect(runs.find((run) => run.lane === "CASEIQ")?.queued).toBe(false);
    expect(await db.run.findUnique({ where: { id: waiting.runId } })).toMatchObject({
      resumedFromRunId: cli.runId, concurrencyMode: QUEUED_FOLLOW_UP_MODE,
    });
    const next = await sendPairedFollowUp(work.userId, work.id, {
      ...followUp, requestId: randomUUID(), targets: [{ lane: "CLI", expectedParentRunId: waiting.runId }],
    });
    expect(next.runs).toEqual([{ lane: "CLI", sessionId: cli.sessionId, queued: true, runId: expect.any(String) }]);
    await finalizeCancelledWorkRun(waiting.runId, "Synthetic cancellation");
    const artifact = getWorkRunArtifactPaths(pairedWorkspacePath(work.directoryPath, pair, "CLI"), waiting.runId);
    expect(JSON.parse(await readFile(artifact.snapshot, "utf8"))).toMatchObject({ status: "CANCELLED", sessionId: cli.sessionId });
    expect(await db.run.findUnique({ where: { id: next.runs[0].runId } })).toMatchObject({ status: "PENDING" });
    expect(await db.run.findUnique({ where: { id: runs.find((run) => run.lane === "CASEIQ")!.runId } })).toMatchObject({ status: "PENDING" });
  });

  it("rejects stale targets, another owner and redirected output without a partial send", async () => {
    const { pair, followUp } = await initial();
    const invalid = { ...followUp, targets: [followUp.targets[0], { lane: "CASEIQ" as const, expectedParentRunId: "stale" }] };
    await expect(sendPairedFollowUp(work.userId, work.id, invalid)).rejects.toThrow("selected Run changed");
    await expect(sendPairedFollowUp("different-user", work.id, followUp)).rejects.toThrow("Work not found");
    const original = pairedWorkspacePath(work.directoryPath, pair, "CASEIQ");
    const parked = `${original}-parked`;
    await rename(original, parked);
    await symlink(parked, original, "junction");
    await expect(sendPairedFollowUp(work.userId, work.id, followUp)).rejects.toThrow("redirected");
    expect(await db.run.count({ where: { workId: work.id } })).toBe(2);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it("rolls back both Runs when SQLite rejects the second insert", async () => {
    const { followUp } = await initial();
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_paired_fixture BEFORE INSERT ON Run
      WHEN NEW.engine = 'CASEIQ' AND NEW.trigger = 'FOLLOW_UP'
      BEGIN SELECT RAISE(ABORT, 'synthetic second insert failure'); END`);
    try {
      await expect(sendPairedFollowUp(work.userId, work.id, followUp)).rejects.toThrow();
      expect(await db.run.count({ where: { workId: work.id, trigger: "FOLLOW_UP" } })).toBe(0);
      expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    } finally { await db.$executeRawUnsafe("DROP TRIGGER reject_paired_fixture"); }
  });

  it("rolls back the pairing and removes only its new empty folders if initial admission fails", async () => {
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_initial_fixture BEFORE INSERT ON Run
      WHEN NEW.engine = 'CASEIQ' AND NEW.trigger = 'WORK'
      BEGIN SELECT RAISE(ABORT, 'synthetic second insert failure'); END`);
    try {
      await expect(startPairedWork(work.userId, work.id)).rejects.toThrow();
      expect(await db.run.count({ where: { workId: work.id } })).toBe(0);
      expect(await db.workSessionPair.findUnique({ where: { workId: work.id } })).toBeNull();
      expect((await readdir(work.directoryPath)).some((entry) => entry.startsWith("work-results-"))).toBe(false);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    } finally { await db.$executeRawUnsafe("DROP TRIGGER reject_initial_fixture"); }
  });

  it("serializes concurrent broadcasts and handles same-request retries without duplicate Runs", async () => {
    const { followUp } = await initial();
    const requests = await Promise.allSettled([
      sendPairedFollowUp(work.userId, work.id, followUp), sendPairedFollowUp(work.userId, work.id, followUp),
    ]);
    expect(requests.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    if (requests[0].status !== "fulfilled") throw new Error("The first broadcast was not accepted.");
    const retry = await sendPairedFollowUp(work.userId, work.id, followUp);
    expect(retry.runs).toHaveLength(2);
    expect(retry.runs).toEqual(expect.arrayContaining(requests[0].value.runs));
    expect(await db.run.count({ where: { workId: work.id } })).toBe(4);
    expect(mocks.enqueue).toHaveBeenCalledTimes(4);
  });

  it("does not reserve the CLI-only tab when authentication reserves only the CaseIQ Session", async () => {
    const { cli, caseiq, followUp } = await initial();
    mocks.authBlocked.mockImplementation(async (keys: string[]) =>
      keys.includes(`session:${caseiq.sessionId}`) ? "Finish SupportIQ sign-in first." : null);
    await expect(sendPairedFollowUp(work.userId, work.id, followUp)).rejects.toThrow("Finish SupportIQ sign-in");
    const cliOnly = await sendPairedFollowUp(work.userId, work.id, { ...followUp,
      targets: [{ lane: "CLI", expectedParentRunId: cli.runId }] });
    expect(cliOnly.runs).toEqual([{ runId: expect.any(String), lane: "CLI", sessionId: cli.sessionId, queued: true }]);
    expect(await db.run.count({ where: { workId: work.id } })).toBe(3);
  });

  it("blocks an unrelated Run in the shared input tree and releases preflight failures without creating output folders", async () => {
    const child = path.join(work.directoryPath, "nested");
    await mkdir(child);
    const other = await db.work.create({ data: {
      userId: work.userId, name: "Unrelated Work", directoryPath: child, canonicalPath: canonicalizeWorkPath(child),
      promptFileName: "PROMPT.md", hostname: hostname(),
    } });
    await db.run.create({ data: {
      workId: other.id, hostname: hostname(), executionPath: child, status: "RUNNING", trigger: "WORK", engine: "CLI",
    } });
    await expect(startPairedWork(work.userId, work.id)).rejects.toThrow("using this Work directory");
    expect(await db.workSessionPair.findUnique({ where: { workId: work.id } })).toBeNull();
    expect((await readdir(work.directoryPath)).some((entry) => entry.startsWith("work-results-"))).toBe(false);
    await expect(assertPairedInputDirectory(installation, installation)).rejects.toThrow("separate from the CaseIQ checkout");
  });
});
