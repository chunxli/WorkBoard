import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  work: vi.fn(), run: vi.fn(), findRun: vi.fn(), createRun: vi.fn(), createLaunch: vi.fn(),
  updateLaunch: vi.fn(), transaction: vi.fn(), spawn: vi.fn(), prepare: vi.fn(), monitor: vi.fn(),
  artifacts: vi.fn(), repair: vi.fn(), conflicts: vi.fn(), assertSession: vi.fn(),
  exists: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  work: { findFirst: mocks.work },
  run: { findFirst: mocks.findRun, findUniqueOrThrow: mocks.run, create: mocks.createRun },
  terminalLaunch: { create: mocks.createLaunch, updateMany: mocks.updateLaunch },
  $transaction: mocks.transaction,
} }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
vi.mock("@/lib/caseiq-integration", () => ({
  prepareCaseIqTerminal: mocks.prepare, monitorCaseIqPreparation: mocks.monitor,
  ensurePrivateRuntimeDirectory: vi.fn(async (directory: string) => {
    await mkdir(directory, { recursive: true });
  }),
  acceptCaseIqPreparation: vi.fn(async () => true),
}));
vi.mock("@/lib/native-session-bindings", async (original) => ({
  ...await original<typeof import("./native-session-bindings")>(),
  readNativeSessionBindingSync: (sessionId: string) => ({ sessionId, home: "C:\\synthetic", userId: "owner", workId: "work" }),
}));
vi.mock("@/lib/run-access", () => ({ findActiveRunConflicts: mocks.conflicts }));
vi.mock("@/lib/git-safety", () => ({ getHeadCommit: async () => null }));
vi.mock("@/lib/work-files", () => ({
  readWorkPrompt: async () => ({ content: "Saved Work Prompt", hash: "hash" }),
  hashWorkContent: (value: string) => `hash:${value}`,
}));
vi.mock("@/lib/work-attachments", () => ({ readInitialWorkAttachments: async () => [] }));
vi.mock("@/lib/run-source-snapshot", () => ({
  captureRunSourceBaseline: async () => null, inheritRunSourceBaseline: async () => null,
  isRunSourceBaselineReady: async () => true,
}));
vi.mock("@/lib/run-artifacts", async (original) => ({
  ...await original<typeof import("./run-artifacts")>(), prepareRunArtifacts: mocks.artifacts,
  readWorkRunSnapshot: mocks.snapshot,
}));
vi.mock("@/lib/copilot-session-compat", async (original) => ({
  ...await original<typeof import("./copilot-session-compat")>(),
  assertCopilotSessionNotInUse: mocks.assertSession,
  copilotSessionHasHistory: mocks.exists,
  repairLegacyCopilotSessionEvents: mocks.repair,
  readCopilotSessionSnapshot: async () => ({ events: [{ type: "assistant.message" }] }),
}));

import { isTerminalResumeReady, launchNewWorkTerminal, launchTerminalResume } from "./terminal-resume";

let root: string;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-terminal-"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const work = {
    id: "work", userId: "owner", name: "Synthetic work", directoryPath: root, promptFileName: "PROMPT.md",
    hostname: hostname(), status: "ACTIVE", model: "work-cli-model", agent: "cli-agent",
    permissionMode: "full", contextTier: "long_context", reasoningEffort: "high",
  };
  mocks.work.mockResolvedValue(work);
  mocks.findRun.mockResolvedValue(null);
  mocks.conflicts.mockResolvedValue([]);
  mocks.transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
  mocks.createRun.mockResolvedValue({});
  mocks.createLaunch.mockResolvedValue({});
  mocks.updateLaunch.mockResolvedValue({ count: 1 });
  mocks.assertSession.mockResolvedValue(undefined);
  mocks.exists.mockResolvedValue(true);
  mocks.snapshot.mockResolvedValue({ finishedAt: new Date().toISOString(), gitAfterTree: null });
  mocks.prepare.mockImplementation(async (options: { runId: string; launchId: string; sessionId: string }) => ({
    ...options, requestFile: path.join(root, "private-request.json"),
    script: path.join(root, "trusted-caseiq.ps1"),
    arguments: ["-RequestFile", path.join(root, "private-request.json")],
    environment: { CASEIQ_HOME: path.join(root, "private-caseiq") },
  }));
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  mocks.run.mockResolvedValue({
    id: "parent", providerId: "caseiq", workId: work.id, taskId: null, work, task: null,
    status: "SUCCESS", trigger: "TERMINAL_START", hostname: hostname(),
    copilotSessionId: "12345678-1234-4234-8234-123456789abc", executionPath: root,
    promptSnapshot: "", model: null, agent: null, fallbackModel: null,
    contextTier: null, reasoningEffort: null, permissionMode: "caseiq-managed",
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("CaseIQ native Terminal dispatch", () => {
  it("allows explicit new CaseIQ sessions without inheriting CLI settings or broad permissions", async () => {
    mocks.findRun.mockResolvedValueOnce({ id: "previous-run" });
    const launched = await launchNewWorkTerminal("owner", "work", {
      packs: ["platform"], caseNumber: null, sendPrompt: false,
    });
    expect(launched.runId).toBeTypeOf("string");
    const data = mocks.createRun.mock.calls[0][0].data;
    expect(data).toMatchObject({
      providerId: "caseiq", engine: "CLI", trigger: "TERMINAL_START", promptSnapshot: "",
      model: null, agent: null, fallbackModel: null, contextTier: null, reasoningEffort: null,
      permissionMode: "caseiq-managed",
    });
    const args: string[] = mocks.spawn.mock.calls[0][1];
    expect(args).toContain(path.join(root, "trusted-caseiq.ps1"));
    expect(args).not.toContain("Bypass");
    expect(args).not.toContain("--allow-all");
    expect(mocks.monitor).toHaveBeenCalledOnce();
  });

  it("resumes through the CaseIQ adapter with the exact native session and without rewriting its history", async () => {
    await launchTerminalResume("parent");
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "12345678-1234-4234-8234-123456789abc", resume: true, prompt: "",
      launch: { packs: [], caseNumber: null, sendPrompt: false },
    }));
    expect(mocks.createRun.mock.calls[0][0].data).toMatchObject({
      providerId: "caseiq", trigger: "TERMINAL_RESUME",
      command: "CaseIQ --resume=<session> (native Terminal)",
    });
    expect(mocks.spawn.mock.calls[0][1]).toContain(path.join(root, "trusted-caseiq.ps1"));
  });

  it("rejects foreign-host Work and active directory conflicts before preparing CaseIQ", async () => {
    const work = await mocks.work();
    mocks.work.mockResolvedValueOnce({ ...work, hostname: "another-host" });
    await expect(launchNewWorkTerminal("owner", "work", { packs: [], caseNumber: null, sendPrompt: false })).rejects.toThrow("another machine");
    mocks.conflicts.mockResolvedValueOnce([{ id: "active" }]);
    await expect(launchNewWorkTerminal("owner", "work", { packs: [], caseNumber: null, sendPrompt: false })).rejects.toThrow("active Run");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("refuses direct Resume when the recorded native history has disappeared", async () => {
    mocks.exists.mockResolvedValue(false);
    await expect(launchTerminalResume("parent")).rejects.toThrow("binding is unavailable");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not advertise a deleted native history as resumable even when the source baseline is ready", async () => {
    mocks.snapshot.mockResolvedValue({
      finishedAt: new Date().toISOString(), gitAfterTree: null, providerId: "caseiq",
      sessionId: "12345678-1234-4234-8234-123456789abc",
    });
    const run = { id: "caseiq-run", taskId: null, status: "UNKNOWN", work: { directoryPath: root } };
    mocks.exists.mockResolvedValue(false);
    await expect(isTerminalResumeReady(run)).resolves.toBe(false);
    mocks.exists.mockResolvedValue(true);
    await expect(isTerminalResumeReady(run)).resolves.toBe(true);
    expect(mocks.exists).toHaveBeenLastCalledWith("12345678-1234-4234-8234-123456789abc", "C:\\synthetic");
  });

  it("resumes a CaseIQ web or paired CaseIQ lane session via CaseIQ with verified PowerShell 7 and preserves CASEIQ engine", async () => {
    const cliSessionId = "11111111-1111-4111-8111-111111111111";
    const caseIqSessionId = "12345678-1234-4234-8234-123456789abc";
    const { mkdir: makeDir } = await import("node:fs/promises");
    const workDirectory = path.join(root, "paired-workspace");
    await makeDir(workDirectory, { recursive: true });
    vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", path.join(root, "private-state"));
    const { provisionPairedWorkspaces } = await import("./work-pair-directories");
    const pairedDirs = await provisionPairedWorkspaces(workDirectory, { cliSessionId, caseIqSessionId });
    const pairedWork = {
      ...(await mocks.work()),
      directoryPath: workDirectory,
      sessionPair: { cliSessionId, caseIqSessionId },
    };
    mocks.run.mockResolvedValue({
      id: "12345678-1234-4234-8234-000000000001",
      providerId: "caseiq",
      engine: "CASEIQ",
      workId: pairedWork.id,
      taskId: null,
      work: pairedWork,
      task: null,
      status: "SUCCESS",
      trigger: "WORK",
      hostname: hostname(),
      copilotSessionId: caseIqSessionId,
      executionPath: pairedDirs.caseIq,
      promptSnapshot: "Investigate case",
      model: null,
      agent: null,
      fallbackModel: null,
      contextTier: null,
      reasoningEffort: null,
      permissionMode: "default",
    });
    mocks.prepare.mockResolvedValueOnce({
      requestFile: path.join(root, "paired-request.json"),
      runId: "resumed-caseiq",
      sessionId: caseIqSessionId,
      launchId: "launch-caseiq",
      powerShellExecutable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      script: path.join(root, "trusted-caseiq.ps1"),
      arguments: ["-RequestFile", path.join(root, "paired-request.json")],
      environment: { CASEIQ_HOME: path.join(root, "private-caseiq") },
    });

    await launchTerminalResume("12345678-1234-4234-8234-000000000001");

    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: caseIqSessionId,
      workingDirectory: pairedDirs.caseIq,
      sharedInputDirectory: workDirectory,
      resume: true,
    }));
    expect(mocks.createRun.mock.calls[0][0].data).toMatchObject({
      engine: "CASEIQ",
      providerId: "caseiq",
      trigger: "TERMINAL_RESUME",
      executionPath: pairedDirs.caseIq,
      copilotSessionId: caseIqSessionId,
    });
    const spawnArgs: string[] = mocks.spawn.mock.calls[0][1];
    expect(spawnArgs).toContain("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(spawnArgs).toContain(path.join(root, "trusted-caseiq.ps1"));
  });
});
