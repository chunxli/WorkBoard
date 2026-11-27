import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import {
  buildTerminalLaunchEnvironmentOverrides,
  extractDisabledMcpServersFromArgs,
  resolveSupportIqCliBridgeArgs,
} from "@/lib/copilot-entra";
import { buildCopilotEnvironment } from "@/lib/copilot-runner";
import {
  assertCopilotSessionNotInUse,
  copilotSessionHasHistory,
  CopilotSessionInUseError,
  processIsAlive,
  readCopilotSessionSnapshot,
  repairLegacyCopilotSessionEvents,
} from "@/lib/copilot-session-compat";
import {
  getHeadCommit,
} from "@/lib/git-safety";
import {
  checkpointRunHistory,
  finalizeWorkRunArtifacts,
  getAutomationRunArtifactPaths,
  getWorkRunArtifactPaths,
  prepareRunArtifacts,
  readWorkRunSnapshot,
  serializeRunFinalization,
  type WorkRunSnapshot,
} from "@/lib/run-artifacts";
import {
  captureRunSourceBaseline,
  captureRunSourceDiff,
  inheritRunSourceBaseline,
  isRunSourceBaselineReady,
} from "@/lib/run-source-snapshot";
import { getRepoWorkdirPath } from "@/lib/repo-workdir";
import { hashWorkContent, readWorkPrompt } from "@/lib/work-files";
import { readInitialWorkAttachments } from "@/lib/work-attachments";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import {
  analyzeCopilotSessionEvents,
  serializeCopilotTokenUsage,
  subtractCopilotTokenUsage,
} from "@/lib/copilot-session-insights";
import type { CopilotCompletionSummary } from "@/lib/copilot-completion";
import { isTerminalRunTrigger, TERMINAL_HISTORY_STABLE_MS } from "@/lib/terminal-run";
import { findActiveRunConflicts } from "@/lib/run-access";
import { getDirectorySnapshotPath } from "@/lib/directory-snapshot";
import { TERMINAL_COMPLETION_UNCONFIRMED } from "@/lib/work-run-status";
import { CASEIQ_PROVIDER_ID } from "@/lib/runtime-provider";
import type { CaseIqLaunchOptions } from "@/lib/caseiq-options";
import {
  acceptCaseIqPreparation, ensurePrivateRuntimeDirectory, monitorCaseIqPreparation,
  prepareCaseIqTerminal, type CaseIqTerminalSpec,
} from "@/lib/caseiq-integration";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { nativeSessionBindingHome, readNativeSessionBindingSync } from "@/lib/native-session-bindings";
import { WINDOWS_PROCESS_START_TIME, windowsProcessMatchesStartTime } from "@/lib/copilot-process";
import {
  verifyPairedRunDirectory,
  WorkPairError,
  workspaceInstructionEnvironment,
  writePairedWorkspaceInstructions,
  type PairWorkspaceWork,
} from "@/lib/work-pair-directories";
import { pairedWorkLane } from "@/lib/work-session-pair";

export class TerminalResumeInProgressError extends Error {
  constructor() {
    super("This Copilot session is already being opened in a terminal");
    this.name = "TerminalResumeInProgressError";
  }
}

export class TerminalResumeNotReadyError extends Error {
  constructor() {
    super("Terminal Resume baseline is not ready for this Run");
    this.name = "TerminalResumeNotReadyError";
  }
}

const UNKNOWN_TERMINAL_EXIT_ERROR =
  TERMINAL_COMPLETION_UNCONFIRMED;

export interface TerminalRunOutcome {
  status: "SUCCESS" | "FAILED" | "UNKNOWN";
  exitCode: number | null;
  errorMessage: string | null;
}

export function resolveTerminalRunOutcome(
  exitCode: number | null,
  completion: CopilotCompletionSummary,
  requireCompletion = false
): TerminalRunOutcome {
  if (exitCode !== null && (exitCode !== 0 || !requireCompletion)) {
    return {
      status: exitCode === 0 ? "SUCCESS" : "FAILED",
      exitCode,
      errorMessage: exitCode === 0 ? null : `Copilot exited with code ${exitCode}`,
    };
  }

  const hasCompletionEvidence =
    completion.taskComplete || completion.rootFinalOutput !== null;
  const isComplete =
    hasCompletionEvidence &&
    !completion.aborted &&
    completion.openSubagents.length === 0 &&
    completion.openTools.length === 0;
  return {
    status: isComplete ? "SUCCESS" : "UNKNOWN",
    exitCode,
    errorMessage: isComplete ? null : UNKNOWN_TERMINAL_EXIT_ERROR,
  };
}

const MAX_WINDOWS_INITIAL_PROMPT_CHARACTERS = 20_000;

export interface NewTerminalSessionOptions {
  sessionId: string;
  workName: string;
  prompt: string;
  promptFileName: string;
  agent: string | null;
  model: string | null;
  contextTier: string | null;
  reasoningEffort: string | null;
  permissionMode: string | null;
}

export function buildNewTerminalSessionArgs(
  options: NewTerminalSessionOptions
): string[] {
  const initialPrompt = options.prompt.length <= MAX_WINDOWS_INITIAL_PROMPT_CHARACTERS
    ? options.prompt
    : `Read ${options.promptFileName} in the current directory and complete all instructions in it.`;
  const args = [
    "--session-id",
    options.sessionId,
    "--name",
    options.workName,
    "-i",
    initialPrompt,
    "--output-format",
    "text",
    options.permissionMode === "full" ? "--allow-all" : "--allow-all-tools",
  ];
  if (options.agent) args.push("--agent", options.agent);
  if (options.model) args.push("--model", options.model);
  if (options.contextTier) args.push("--context", options.contextTier);
  if (options.reasoningEffort) args.push("--effort", options.reasoningEffort);
  args.push("--secret-env-vars", "GH_TOKEN,GITHUB_TOKEN");
  return args;
}

export function spawnDetached(executable: string, args: string[], cwd: string, environment: Partial<NodeJS.ProcessEnv> = {}): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      env: { ...buildCopilotEnvironment(), ...environment },
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid ?? null);
    });
  });
}

function lastAssistantMessage(events: unknown[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as { type?: unknown; data?: { content?: unknown } };
    if (event.type === "assistant.message" && typeof event.data?.content === "string") {
      return event.data.content;
    }
  }
  return null;
}

export async function launchTerminalResume(parentRunId: string): Promise<{
  runId: string;
  launcherPid: number | null;
}> {
  const candidate = await prisma.run.findUniqueOrThrow({
    where: { id: parentRunId },
    select: {
      copilotSessionId: true, workId: true, taskId: true, status: true, trigger: true, providerId: true,
      work: { select: { sessionPair: { select: { cliSessionId: true, caseIqSessionId: true } } } },
    },
  });
  if (!candidate.copilotSessionId) {
    throw new Error("This run does not have a resumable Copilot session");
  }
  if (candidate.status === "RUNNING" && isTerminalRunTrigger(candidate.trigger)) {
    await reconcileTerminalRun(parentRunId, new Date(), { settleStopped: true });
  }
  const pairedLane = candidate.work?.sessionPair
    ? pairedWorkLane(candidate.work.sessionPair, candidate.copilotSessionId)
    : null;
  const ownerKey = pairedLane
    ? `paired:${candidate.workId}:${pairedLane}`
    : candidate.workId
      ? `work:${candidate.workId}`
      : `task:${candidate.taskId}`;
  try {
    return await withRunStartLock(
      [ownerKey, `session:${candidate.copilotSessionId}`],
      () => launchTerminalResumeUnlocked(parentRunId),
      { checkWorkAuthentication: !pairedLane || pairedLane === "CASEIQ" }
    );
  } catch (error) {
    if (error instanceof RunStartInProgressError) {
      throw new TerminalResumeInProgressError();
    }
    throw error;
  }
}

async function launchTerminalResumeUnlocked(parentRunId: string): Promise<{
  runId: string;
  launcherPid: number | null;
}> {
  const parentRun = await prisma.run.findUniqueOrThrow({
    where: { id: parentRunId },
    include: { work: { include: { sessionPair: true } }, task: { include: { repo: true } } },
  });
  if (parentRun.providerId && parentRun.providerId !== CASEIQ_PROVIDER_ID) {
    throw new TerminalStartError("This runtime does not have a supported native Terminal adapter.");
  }
  const caseIq = parentRun.providerId === CASEIQ_PROVIDER_ID;
  if (caseIq && !parentRun.work) throw new TerminalStartError("CaseIQ Automations are not supported.");
  if (caseIq) {
    const binding = parentRun.copilotSessionId ? readNativeSessionBindingSync(parentRun.copilotSessionId) : null;
    const boundHome = binding ? nativeSessionBindingHome(binding) : null;
    if (!boundHome || binding?.workId !== parentRun.workId || binding?.userId !== parentRun.work?.userId ||
        !await copilotSessionHasHistory(binding.sessionId, boundHome)) {
      throw new CaseIqIntegrationError("The original CaseIQ binding is unavailable. Start a new CaseIQ Terminal session explicitly.");
    }
  }
  if ((!parentRun.work && !parentRun.task) || !parentRun.copilotSessionId) {
    throw new Error("This run does not have a resumable Copilot session");
  }
  if (parentRun.status === "PENDING" || parentRun.status === "RUNNING") {
    throw new TerminalResumeInProgressError();
  }
  if (parentRun.work?.status === "ARCHIVED" || parentRun.task?.archivedAt) {
    throw new Error("Restore this Work before resuming its session");
  }
  if (parentRun.hostname && parentRun.hostname !== hostname()) {
    throw new Error("This session belongs to another machine");
  }

  const work = parentRun.work;
  const task = parentRun.task;
  const pair = work?.sessionPair ?? null;
  let pairedArtifactRoot: string | null = null;
  if (pair && work) {
    try {
      pairedArtifactRoot = await verifyPairedRunDirectory(work, parentRun);
    } catch (error) {
      if (error instanceof WorkPairError) throw new TerminalStartError(error.message, error.status);
      throw error;
    }
  }
  const activeOwnerRun = await prisma.run.findFirst({
    where: pair
      ? {
          status: { in: ["PENDING", "RUNNING"] },
          OR: [
            { copilotSessionId: parentRun.copilotSessionId },
            { workId: parentRun.workId, copilotSessionId: { notIn: [pair.cliSessionId, pair.caseIqSessionId] } },
          ],
        }
      : {
          ...(parentRun.workId
            ? { workId: parentRun.workId }
            : { taskId: parentRun.taskId }),
          status: { in: ["PENDING", "RUNNING"] },
        },
    select: { id: true },
  });
  if (activeOwnerRun) {
    throw new TerminalResumeInProgressError();
  }

  const executionPath =
    pairedArtifactRoot ??
    parentRun.executionPath ??
    work?.directoryPath ??
    (task ? getRepoWorkdirPath(task.repo) : null);
  if (!executionPath) throw new Error("The run has no working directory");
  const workArtifactRoot = pairedArtifactRoot ?? work?.directoryPath ?? null;
  const runId = randomUUID();
  const launchId = randomUUID();
  const paths = task
    ? getAutomationRunArtifactPaths(runId)
    : getWorkRunArtifactPaths(workArtifactRoot!, runId);
  const parentPaths = task
    ? getAutomationRunArtifactPaths(parentRun.id)
    : getWorkRunArtifactPaths(workArtifactRoot!, parentRun.id);
  const parentSnapshot = await readWorkRunSnapshot(parentPaths.snapshot).catch(() => null);
  if (!parentSnapshot?.finishedAt) throw new TerminalResumeNotReadyError();

  const sourceArtifactRoot = task ? parentPaths.outputDirectory : workArtifactRoot!;
  const artifactRoot = task ? paths.outputDirectory : workArtifactRoot!;
  const baselineReady = await isRunSourceBaselineReady({
    workDirectory: sourceArtifactRoot,
    runId: parentRun.id,
    gitTree: parentSnapshot.gitAfterTree,
  });
  if (!baselineReady) throw new TerminalResumeNotReadyError();

  const repairResult = caseIq
    ? { eventCount: (await readCopilotSessionSnapshot(parentRun.copilotSessionId)).events.length }
    : await repairLegacyCopilotSessionEvents(parentRun.copilotSessionId);
  await assertCopilotSessionNotInUse(parentRun.copilotSessionId);
  const beforeTree = await inheritRunSourceBaseline({
    sourceWorkDirectory: sourceArtifactRoot,
    sourceRunId: parentRun.id,
    sourceGitTree: parentSnapshot.gitAfterTree,
    targetWorkDirectory: artifactRoot,
    targetRunId: runId,
  });
  const baseCommit = pair ? null : await getHeadCommit(executionPath).catch(() => null);
  const sessionEventCursorStart = repairResult.eventCount;
  const startedAt = new Date();
  const prompt = parentRun.promptSnapshot ?? task?.prompt ?? work?.promptCache ?? "";
  const resumedEngine = caseIq && parentRun.engine === "CASEIQ" ? "CASEIQ" : "CLI";
  const snapshot: WorkRunSnapshot = {
    schemaVersion: 1,
    runId,
    workId: parentRun.workId,
    workName: task?.name ?? work!.name,
    promptFileName: task ? null : work!.promptFileName,
    prompt,
    promptHash: hashWorkContent(prompt),
    engine: resumedEngine,
    providerId: parentRun.providerId,
    sessionId: parentRun.copilotSessionId,
    executionPath,
    concurrencyMode: "EXTERNAL_TERMINAL",
    trigger: "TERMINAL_RESUME",
    resumedFromRunId: parentRun.id,
    status: "RUNNING",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    exitCode: null,
    errorMessage: null,
    gitBeforeTree: beforeTree,
    gitAfterTree: null,
    sessionEventCursorStart,
    taskId: parentRun.taskId,
    resourceName: task?.repo.name ?? null,
    agent: parentRun.agent,
    model: parentRun.model,
    fallbackModel: parentRun.fallbackModel,
    contextTier: parentRun.contextTier,
    reasoningEffort: parentRun.reasoningEffort,
    permissionMode: parentRun.permissionMode,
    outputFormat: "json",
    timeoutSeconds: null,
  };
  await prepareRunArtifacts(paths, snapshot);

  await prisma.$transaction([
    prisma.run.create({
      data: {
        id: runId,
        taskId: parentRun.taskId,
        workId: parentRun.workId,
        status: "RUNNING",
        trigger: "TERMINAL_RESUME",
        engine: resumedEngine,
        providerId: parentRun.providerId,
        executionPath,
        promptSnapshot: snapshot.prompt,
        outputFormat: "json",
        agent: parentRun.agent,
        model: parentRun.model,
        fallbackModel: parentRun.fallbackModel,
        contextTier: parentRun.contextTier,
        reasoningEffort: parentRun.reasoningEffort,
        permissionMode: parentRun.permissionMode,
        outputDir: paths.outputDirectory,
        logPath: paths.stdout,
        copilotSessionId: parentRun.copilotSessionId,
        concurrencyMode: "EXTERNAL_TERMINAL",
        resumedFromRunId: parentRun.id,
        baseCommit,
        startedAt,
        hostname: hostname(),
        command: caseIq ? "CaseIQ --resume=<session> (native Terminal)" : "copilot --resume=<session>",
      },
    }),
    prisma.terminalLaunch.create({
      data: {
        id: launchId,
        runId,
      },
    }),
  ]);

  const launchFile = path.join(process.cwd(), "data", "terminal-launches", `${launchId}.json`);
  const launcherScript = path.join(process.cwd(), "scripts", "workboard-resume.ps1");
  try {
    const pairedWorkspace = pair && work
      ? await writePairedWorkspaceInstructions(work.directoryPath, executionPath, runId, ensurePrivateRuntimeDirectory)
      : undefined;
    const caseIqSpec = caseIq ? await prepareCaseIqTerminal({
      userId: work!.userId, workId: work!.id, workingDirectory: executionPath,
      sessionId: parentRun.copilotSessionId, runId, launchId, prompt: "",
      launch: { packs: [], caseNumber: null, sendPrompt: false }, resume: true,
      sharedInputDirectory: pairedWorkspace?.inputDirectory,
    }) : null;
    const cliEnvironment = caseIqSpec
      ? null
      : workspaceInstructionEnvironment(buildCopilotEnvironment(), pairedWorkspace);
    const cliBridgeArgs = cliEnvironment
      ? resolveSupportIqCliBridgeArgs({
          environment: cliEnvironment,
          workingDirectory: executionPath,
          interactiveAuth: true,
        })
      : [];
    const launchEnvironmentOverrides = cliEnvironment
      ? buildTerminalLaunchEnvironmentOverrides(cliEnvironment)
      : undefined;
    if (caseIq) await ensurePrivateRuntimeDirectory(path.dirname(launchFile));
    await mkdir(path.dirname(launchFile), { recursive: true });
    await writeFile(
      launchFile,
      JSON.stringify({
        sessionId: parentRun.copilotSessionId,
        workingDirectory: executionPath,
        ...(pairedWorkspace && !caseIqSpec ? { sharedInputDirectory: pairedWorkspace.inputDirectory } : {}),
        ...(cliBridgeArgs.length > 0 ? { extraArgs: cliBridgeArgs } : {}),
        ...(launchEnvironmentOverrides ? { environment: launchEnvironmentOverrides } : {}),
        ...(caseIqSpec ? { providerId: CASEIQ_PROVIDER_ID, caseIqRequestFile: caseIqSpec.requestFile } : {}),
      }),
      { encoding: "utf8", flag: "wx" }
    );
    const launcherPid = await spawnDetached(
      "wt.exe",
      [
        "--window",
        "new",
        "new-tab",
        "--startingDirectory",
        executionPath,
        "--title",
        `${caseIq ? "CaseIQ" : "Work Board"} ${runId.slice(0, 8)}`,
        caseIqSpec?.powerShellExecutable ?? "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        ...(caseIq ? [] : ["-ExecutionPolicy", "Bypass"]),
        "-File",
        caseIqSpec?.script ?? launcherScript,
        ...(caseIqSpec?.arguments ?? ["-LaunchFile", launchFile]),
      ],
      executionPath,
      caseIqSpec
        ? workspaceInstructionEnvironment(caseIqSpec.environment as NodeJS.ProcessEnv, pairedWorkspace)
        : cliEnvironment!
    );
    await prisma.terminalLaunch.updateMany({
      where: { id: launchId, status: "PENDING" },
      data: { status: "LAUNCHED", launcherPid, launchedAt: new Date() },
    });
    if (caseIqSpec) monitorCaseIqPreparation(caseIqSpec);
    return { runId, launcherPid };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    await finalizeWorkRunArtifacts({
      paths,
      snapshot: { ...snapshot, status: "FAILED", finishedAt: finishedAt.toISOString(), errorMessage },
      finalOutput: null,
      diff: "",
    });
    await prisma.$transaction([
      prisma.run.update({
        where: { id: runId },
        data: { status: "FAILED", errorMessage, finishedAt },
      }),
      prisma.terminalLaunch.update({
        where: { id: launchId },
        data: { status: "FAILED", errorMessage, completedAt: finishedAt },
      }),
    ]);
    await rm(launchFile, { force: true }).catch(() => {});
    throw error;
  }
}

export async function isTerminalResumeReady(run: {
  id: string;
  taskId: string | null;
  status: string;
  executionPath?: string | null;
  copilotSessionId?: string | null;
  engine?: string | null;
  providerId?: string | null;
  work: { directoryPath: string; sessionPair?: PairWorkspaceWork["sessionPair"] | object | null } | null;
}): Promise<boolean> {
  if (run.status === "PENDING" || run.status === "RUNNING") return false;
  let workArtifactRoot: string | null = null;
  if (!run.taskId && run.work) {
    if (run.work.sessionPair) {
      if (
        !("cliSessionId" in run.work.sessionPair) ||
        !("caseIqSessionId" in run.work.sessionPair) ||
        !run.copilotSessionId ||
        !run.executionPath
      ) {
        return false;
      }
      try {
        workArtifactRoot = await verifyPairedRunDirectory(
          { directoryPath: run.work.directoryPath, sessionPair: run.work.sessionPair },
          {
            id: run.id,
            copilotSessionId: run.copilotSessionId,
            engine: run.engine ?? null,
            providerId: run.providerId ?? null,
            executionPath: run.executionPath,
          },
        );
      } catch {
        return false;
      }
    } else {
      workArtifactRoot = run.work.directoryPath;
    }
  }
  const paths = run.taskId
    ? getAutomationRunArtifactPaths(run.id)
    : workArtifactRoot
      ? getWorkRunArtifactPaths(workArtifactRoot, run.id)
      : null;
  if (!paths) return false;

  const snapshot = await readWorkRunSnapshot(paths.snapshot).catch(() => null);
  if (!snapshot?.finishedAt) return false;
  if (snapshot.providerId === CASEIQ_PROVIDER_ID) {
    try {
      const binding = readNativeSessionBindingSync(snapshot.sessionId);
      const boundHome = binding ? nativeSessionBindingHome(binding) : null;
      if (!boundHome || !await copilotSessionHasHistory(snapshot.sessionId, boundHome)) return false;
    } catch (error) {
      console.error("[CaseIQ] Native Resume binding could not be verified.", error);
      return false;
    }
  }
  return isRunSourceBaselineReady({
    workDirectory: run.taskId ? paths.outputDirectory : workArtifactRoot!,
    runId: run.id,
    gitTree: snapshot.gitAfterTree,
  });
}

type FinalizedTerminalRunStatus = "FAILED" | "UNKNOWN";

async function finalizeTerminalRun(
  runId: string,
  status: FinalizedTerminalRunStatus,
  errorMessage: string,
  finishedAt = new Date()
): Promise<boolean> {
  return serializeRunFinalization(runId, async () => {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { work: { include: { sessionPair: true } }, task: { include: { repo: true } } },
    });
    if (!run || !isTerminalRunTrigger(run.trigger)) return false;
    if (run.status !== "RUNNING") return false;

    const workRoot = run.work
      ? run.work.sessionPair
        ? await verifyPairedRunDirectory(run.work, run).catch(() => null)
        : run.work.directoryPath
      : null;
    const paths = run.task
      ? getAutomationRunArtifactPaths(run.id)
      : workRoot
        ? getWorkRunArtifactPaths(workRoot, run.id)
        : null;
    const executionPath =
      workRoot ??
      run.executionPath ??
      run.work?.directoryPath ??
      (run.task ? getRepoWorkdirPath(run.task.repo) : null);
    if (paths && executionPath) {
      const snapshot = await readWorkRunSnapshot(paths.snapshot).catch(() => null);
      if (snapshot) {
        const artifactRoot = run.task ? paths.outputDirectory : workRoot!;
        const sourceDiff = await captureRunSourceDiff({
          executionPath,
          workDirectory: artifactRoot,
          runId: run.id,
          beforeGitTree: snapshot.gitBeforeTree,
        }).catch(() => ({ afterGitTree: null, diff: "" }));
        await finalizeWorkRunArtifacts({
          paths,
          snapshot: {
            ...snapshot,
            status,
            finishedAt: finishedAt.toISOString(),
            errorMessage,
            gitAfterTree: sourceDiff.afterGitTree,
          },
          finalOutput: null,
          diff: sourceDiff.diff,
        }).catch(() => {});
      }
    }

    const updated = await prisma.run.updateMany({
      where: { id: run.id, status: "RUNNING" },
      data: { status, errorMessage, finishedAt },
    });
    if (updated.count === 0) return false;
    if (run.work) {
      const activeRuns = await prisma.run.count({
        where: {
          workId: run.work.id,
          id: { not: run.id },
          status: { in: ["PENDING", "RUNNING"] },
        },
      });
      if (activeRuns === 0) {
        await prisma.work.update({
          where: { id: run.work.id },
          data: { status: "ACTIVE" },
        });
      }
    }
    return true;
  });
}

export async function finalizeFailedTerminalRun(
  runId: string,
  errorMessage: string,
  finishedAt = new Date()
): Promise<boolean> {
  return finalizeTerminalRun(runId, "FAILED", errorMessage, finishedAt);
}

export async function getTerminalSessionActivity(
  sessionId: string, launchId: string | null, createdAt?: Date, observedAt = Date.now(),
) {
  try {
    const binding = readNativeSessionBindingSync(sessionId);
    if (!binding || nativeSessionBindingHome(binding) !== null) await assertCopilotSessionNotInUse(sessionId);
  } catch (error) {
    if (!(error instanceof CopilotSessionInUseError)) throw error;
    return { active: true, wrapperExited: false, exitCode: null, starting: false };
  }
  const launchFile = launchId
    ? path.join(process.cwd(), "data", "terminal-launches", `${launchId}.json`)
    : null;
  const content = launchFile ? await readFile(launchFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }) : null;
  let wrapperPid: number | null = null;
  let wrapperStartTime: string | null = null;
  let exitCode: number | null = null;
  if (content !== null) {
    const launch: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (launch === null || typeof launch !== "object" || Array.isArray(launch)) {
      throw new Error("Terminal launch metadata is invalid; activity could not be verified.");
    }
    if ("wrapperPid" in launch) {
      if (typeof launch.wrapperPid !== "number" || !Number.isInteger(launch.wrapperPid) || launch.wrapperPid <= 0) {
        throw new Error("Terminal wrapper process metadata is invalid; activity could not be verified.");
      }
      wrapperPid = launch.wrapperPid;
    }
    if ("wrapperStartTime" in launch) {
      if (wrapperPid === null || typeof launch.wrapperStartTime !== "string" ||
          !WINDOWS_PROCESS_START_TIME.test(launch.wrapperStartTime)) {
        throw new Error("Terminal wrapper creation identity is invalid; activity could not be verified.");
      }
      wrapperStartTime = launch.wrapperStartTime;
    }
    if ("exitCode" in launch) exitCode = parseTerminalLaunchExitCode(content);
  }
  const wrapperAlive = wrapperPid !== null && processIsAlive(wrapperPid) &&
    (wrapperStartTime === null || await windowsProcessMatchesStartTime(wrapperPid, wrapperStartTime));
  const wrapperExited = wrapperPid !== null && !wrapperAlive;
  return {
    active: exitCode === null && wrapperAlive,
    wrapperExited,
    exitCode,
    starting: wrapperPid === null && exitCode === null && createdAt !== undefined && observedAt - createdAt.getTime() < 120_000,
  };
}

export async function reconcileTerminalRun(
  runId: string,
  now = new Date(),
  { settleStopped = false, stoppedOnly = false }: { settleStopped?: boolean; stoppedOnly?: boolean } = {}
): Promise<void> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { work: { include: { sessionPair: true } }, task: { include: { repo: true } }, resumedRuns: { select: { id: true }, take: 1 } },
  });
  if (
    (!run.work && !run.task) || !run.copilotSessionId || !isTerminalRunTrigger(run.trigger) ||
    !["RUNNING", "UNKNOWN"].includes(run.status) || run.resumedRuns.length > 0 ||
    run.hostname && run.hostname !== hostname()
  ) return;
  const terminalLaunch = await prisma.terminalLaunch.findUniqueOrThrow({ where: { runId } });
  if (terminalLaunch.syncToken && terminalLaunch.syncOwnerPid && processIsAlive(terminalLaunch.syncOwnerPid)) return;
  const token = randomUUID();
  const claim = await prisma.terminalLaunch.updateMany({
    where: {
      runId,
      syncToken: terminalLaunch.syncToken,
      updatedAt: terminalLaunch.updatedAt,
    },
    data: { syncToken: token, syncOwnerPid: process.pid },
  });
  if (claim.count === 0) return;
  const pairedLane = run.work?.sessionPair ? pairedWorkLane(run.work.sessionPair, run.copilotSessionId) : null;
  const ownerLockKey = pairedLane
    ? `paired:${run.workId}:${pairedLane}`
    : run.workId ? `work:${run.workId}` : `task:${run.taskId}`;
  try {
    await withRunStartLock([
      `terminal-sync:${runId}`,
      ownerLockKey,
      `session:${run.copilotSessionId}`,
    ], () => serializeRunFinalization(runId, async () => {
      const conflictingRun = await prisma.run.findFirst({
        where: { id: { not: run.id }, copilotSessionId: run.copilotSessionId, status: { in: ["PENDING", "RUNNING"] } },
        select: { id: true },
      });
      if (conflictingRun) return;
      const activity = await getTerminalSessionActivity(run.copilotSessionId!, terminalLaunch.id, run.createdAt, now.getTime());
      const active = activity.active;
      if (activity.starting || (stoppedOnly && active)) {
        if (terminalLaunch.inactiveSince !== null) {
          await prisma.terminalLaunch.updateMany({
            where: { runId: run.id, syncToken: token },
            data: { inactiveSince: null },
          });
        }
        return;
      }
      const workArtifactRoot = run.work
        ? run.work.sessionPair
          ? await verifyPairedRunDirectory(run.work, run)
          : run.work.directoryPath
        : null;
      const paths = run.task ? getAutomationRunArtifactPaths(run.id) : getWorkRunArtifactPaths(workArtifactRoot!, run.id);
      const priorSnapshot = await readWorkRunSnapshot(paths.snapshot);
      const persistedExitCode = activity.exitCode;
      const launchFile = path.join(process.cwd(), "data", "terminal-launches", `${terminalLaunch.id}.json`);
      if (run.providerId === CASEIQ_PROVIDER_ID) {
        const bound = await acceptCaseIqPreparation(run, terminalLaunch.id);
        if (!bound) {
          if (!active && !activity.starting && (activity.wrapperExited || persistedExitCode !== null)) {
            await finalizeWorkRunArtifacts({
              paths, snapshot: { ...priorSnapshot, status: "FAILED", finishedAt: now.toISOString(), exitCode: persistedExitCode,
                errorMessage: terminalLaunch.errorMessage ?? "CaseIQ native setup ended before its session was bound. Inspect the native Terminal." },
              finalOutput: null, diff: "",
            });
            await prisma.run.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: now, exitCode: persistedExitCode,
              errorMessage: terminalLaunch.errorMessage ?? "CaseIQ native setup did not create a bound session." } });
            await prisma.terminalLaunch.updateMany({
              where: { runId: run.id, syncToken: token },
              data: { status: "FAILED", completedAt: now,
                errorMessage: terminalLaunch.errorMessage ?? "CaseIQ native setup did not create a bound session." },
            });
            if (run.work && run.work.status !== "ARCHIVED") {
              await prisma.work.update({ where: { id: run.work.id }, data: { status: "ACTIVE" } });
            }
          }
          return;
        }
      }
      const history = await readCopilotSessionSnapshot(run.copilotSessionId!).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" || active) throw error;
        return { events: [], incompleteTail: false, size: 0, modifiedAt: new Date(0) };
      });
      const cursor = priorSnapshot.sessionEventCursorStart ?? 0;
      if (cursor > history.events.length) throw new Error("Session history was truncated; refusing to include events from an earlier Run");
      const events = history.events.slice(cursor);
      const insights = analyzeCopilotSessionEvents(history.events, cursor);
      const latestPrompt = events.findLastIndex((event) =>
        event !== null && typeof event === "object" && "type" in event && event.type === "user.message"
      );
      insights.completion = analyzeCopilotSessionEvents(events.slice(Math.max(0, latestPrompt))).completion;
      const priorUsage = analyzeCopilotSessionEvents(history.events.slice(0, cursor)).usage;
      const usageData = serializeCopilotTokenUsage(subtractCopilotTokenUsage(insights.usage, priorUsage));
      const finalOutput = insights.completion.rootFinalOutput ?? lastAssistantMessage(events);
      const unchanged = terminalLaunch.historySize === history.size &&
        terminalLaunch.historyModifiedAt?.getTime() === history.modifiedAt.getTime();
      const inactiveSince = active ? null : unchanged ? terminalLaunch.inactiveSince ?? now : now;
      const settled = !active && (
        settleStopped || inactiveSince !== null && now.getTime() - inactiveSince.getTime() >= TERMINAL_HISTORY_STABLE_MS
      );
      if (run.status === "UNKNOWN" && unchanged && persistedExitCode === null && terminalLaunch.status === "FAILED" && !active) return;
      const activeState = active ? { status: "RUNNING" as const, finishedAt: null, errorMessage: null } : {};
      const checkpoint = { ...priorSnapshot, ...activeState, sessionEventCursorEnd: history.events.length, ...usageData };
      await checkpointRunHistory({ paths, snapshot: checkpoint, events, output: finalOutput });
      if (!settled) {
        await prisma.run.update({ where: { id: run.id }, data: { ...activeState, finalOutput, ...usageData } });
        await prisma.terminalLaunch.updateMany({
          where: { runId, syncToken: token },
          data: { status: "LAUNCHED", completedAt: null, inactiveSince, historySize: history.size, historyModifiedAt: history.modifiedAt, errorMessage: null },
        });
        return;
      }
      const executionPath = workArtifactRoot ?? run.executionPath ?? run.work?.directoryPath ?? (run.task ? getRepoWorkdirPath(run.task.repo) : null);
      if (!executionPath) throw new Error("The run has no working directory");
      const otherOwnerRun = await prisma.run.findFirst({
        where: run.work?.sessionPair
          ? {
              id: { not: run.id },
              copilotSessionId: run.copilotSessionId,
              status: { in: ["PENDING", "RUNNING"] },
            }
          : {
              id: { not: run.id },
              ...(run.workId ? { workId: run.workId } : { taskId: run.taskId }),
              status: { in: ["PENDING", "RUNNING"] },
            },
        select: { id: true },
      });
      if (otherOwnerRun) return;
      const sourceDiff = await captureRunSourceDiff({
        executionPath, workDirectory: run.task ? paths.outputDirectory : workArtifactRoot!,
        runId: run.id, beforeGitTree: priorSnapshot.gitBeforeTree,
      });
      const finalActivity = await getTerminalSessionActivity(run.copilotSessionId!, terminalLaunch.id, run.createdAt);
      if (finalActivity.active || finalActivity.starting) {
        await prisma.terminalLaunch.updateMany({
          where: { runId: run.id, syncToken: token },
          data: { inactiveSince: null },
        });
        return;
      }
      const latest = await readCopilotSessionSnapshot(run.copilotSessionId!).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" || history.size !== 0) throw error;
        return history;
      });
      if (latest.size !== history.size || latest.modifiedAt.getTime() !== history.modifiedAt.getTime()) return;
      const outcome = history.incompleteTail
        ? { status: "UNKNOWN" as const, exitCode: finalActivity.exitCode, errorMessage: "Session history ends with an incomplete record" }
        : resolveTerminalRunOutcome(finalActivity.exitCode, insights.completion, run.providerId === CASEIQ_PROVIDER_ID);
      const finalCommit = run.work?.sessionPair ? null : await getHeadCommit(executionPath).catch(() => null);
      await finalizeWorkRunArtifacts({
        paths,
        snapshot: { ...checkpoint, ...outcome, finishedAt: now.toISOString(), gitAfterTree: sourceDiff.afterGitTree },
        finalOutput, diff: sourceDiff.diff,
      });
      await prisma.$transaction([
        prisma.run.update({ where: { id: run.id }, data: { ...outcome, finalOutput, finalCommit, finishedAt: now, ...usageData } }),
        prisma.terminalLaunch.updateMany({
          where: { runId, syncToken: token },
          data: {
            status: outcome.status === "UNKNOWN" ? "FAILED" : "COMPLETED",
            completedAt: outcome.status === "UNKNOWN" ? null : now,
            inactiveSince, historySize: history.size, historyModifiedAt: history.modifiedAt, errorMessage: outcome.errorMessage,
          },
        }),
      ]);
      if (run.work && run.work.status !== "ARCHIVED") {
        const remainingActive = run.work.sessionPair
          ? Boolean(await prisma.run.findFirst({
              where: { id: { not: run.id }, workId: run.work.id, status: { in: ["PENDING", "RUNNING"] } },
              select: { id: true },
            }))
          : false;
        if (!remainingActive) {
          await prisma.work.update({ where: { id: run.work.id }, data: { status: outcome.status === "SUCCESS" ? "REVIEW" : "ACTIVE" } });
        }
      }
      if (outcome.status !== "UNKNOWN") await rm(launchFile, { force: true }).catch(() => {});
    }), { checkWorkAuthentication: !pairedLane || pairedLane === "CASEIQ" });
  } catch (error) {
    if (error instanceof RunStartInProgressError || error instanceof CopilotSessionInUseError) return;
    await prisma.terminalLaunch.updateMany({
      where: { runId, syncToken: token },
      data: { errorMessage: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  } finally {
    await prisma.terminalLaunch.updateMany({ where: { runId, syncToken: token }, data: { syncToken: null, syncOwnerPid: null } });
  }
}

export function parseTerminalLaunchExitCode(content: string): number {
  const launch = JSON.parse(content.replace(/^\uFEFF/, "")) as { exitCode?: unknown };
  if (
    typeof launch.exitCode !== "number" ||
    !Number.isInteger(launch.exitCode) ||
    launch.exitCode < -1 ||
    launch.exitCode > 2_147_483_647
  ) {
    throw new Error("Terminal exit status is unavailable; waiting for history reconciliation.");
  }
  return launch.exitCode;
}

async function readTerminalLaunchExitCode(launchId: string): Promise<number> {
  const launchFile = path.join(
    process.cwd(),
    "data",
    "terminal-launches",
    `${launchId}.json`
  );
  try {
    return parseTerminalLaunchExitCode(await readFile(launchFile, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Terminal exit status could not be read; retry after the terminal closes.");
    }
    throw error;
  }
}

export class TerminalStartError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "TerminalStartError";
  }
}

function describeTerminalCommand(copilotArgs: string[]): string {
  return `copilot ${copilotArgs
    .map((argument, index) => copilotArgs[index - 1] === "-i" ? "<prompt>" : argument)
    .join(" ")}`;
}

export async function launchNewWorkTerminal(
  userId: string,
  workId: string,
  caseIqOptions?: CaseIqLaunchOptions
): Promise<{ runId: string; launcherPid: number | null }> {
  try {
    return await withRunStartLock([`work:${workId}`], async () => {
      const work = await prisma.work.findFirst({ where: { id: workId, userId }, include: { sessionPair: true } });
      if (!work) throw new TerminalStartError("Work not found", 404);
      if (work.sessionPair) throw new TerminalStartError("Continue paired Sessions from the Work's Conversation.");
      if (work.defaultEngine === "CASEIQ" && !caseIqOptions) {
        throw new TerminalStartError("Use Create & Run or Execute for CaseIQ. The CaseIQ Runtime runs in WorkBoard, not an ordinary Copilot Terminal.");
      }
      if (caseIqOptions && work.hostname && work.hostname !== hostname()) {
        throw new TerminalStartError("This Work belongs to another machine.");
      }
      if (work.status === "ARCHIVED") {
        throw new TerminalStartError("Restore this Work before opening Terminal");
      }
      const priorRun = await prisma.run.findFirst({
        where: { workId: work.id },
        select: { id: true },
      });
      if (priorRun && !caseIqOptions) {
        throw new TerminalStartError("A first Terminal session can only be opened before the Work has run");
      }
      if ((await findActiveRunConflicts(userId, work.directoryPath)).length > 0) {
        throw new TerminalStartError("Wait for the active Run in this Work directory to finish");
      }

      const savedPrompt = await readWorkPrompt(work);
      const attachments = await readInitialWorkAttachments(work);
      if (caseIqOptions?.sendPrompt && attachments.length) {
        throw new TerminalStartError("CaseIQ interactive attachments must be supplied in native Terminal. Open without automatic Prompt delivery and attach files there.");
      }
      const runId = randomUUID();
      const launchId = randomUUID();
      const sessionId = randomUUID();
      const paths = getWorkRunArtifactPaths(work.directoryPath, runId);
      const beforeTree = await captureRunSourceBaseline(
        work.directoryPath,
        work.directoryPath,
        runId
      );
      const baseCommit = await getHeadCommit(work.directoryPath).catch(() => null);
      const startedAt = new Date();
      const copilotArgs = caseIqOptions ? [] : buildNewTerminalSessionArgs({
        sessionId,
        workName: work.name,
        prompt: savedPrompt.content,
        promptFileName: work.promptFileName,
        agent: work.agent,
        model: work.model,
        contextTier: caseIqOptions ? null : work.contextTier,
        reasoningEffort: caseIqOptions ? null : work.reasoningEffort,
        permissionMode: work.permissionMode,
      });
      const command = caseIqOptions ? "CaseIQ (native Terminal)" : describeTerminalCommand(copilotArgs);
      const prompt = caseIqOptions && !caseIqOptions.sendPrompt ? "" : savedPrompt.content;
      const snapshot: WorkRunSnapshot = {
        schemaVersion: 1,
        runId,
        workId: work.id,
        workName: work.name,
        promptFileName: work.promptFileName,
        prompt,
        promptHash: hashWorkContent(prompt),
        attachments: caseIqOptions ? [] : attachments,
        engine: "CLI",
        providerId: caseIqOptions ? CASEIQ_PROVIDER_ID : null,
        sessionId,
        executionPath: work.directoryPath,
        concurrencyMode: "EXTERNAL_TERMINAL",
        trigger: "TERMINAL_START",
        resumedFromRunId: null,
        status: "RUNNING",
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        exitCode: null,
        errorMessage: null,
        gitBeforeTree: beforeTree,
        gitAfterTree: null,
        sessionEventCursorStart: 0,
        agent: caseIqOptions ? null : work.agent,
        model: caseIqOptions ? null : work.model,
        fallbackModel: null,
        contextTier: caseIqOptions ? null : work.contextTier,
        reasoningEffort: caseIqOptions ? null : work.reasoningEffort,
        permissionMode: caseIqOptions ? "caseiq-managed" : work.permissionMode,
        outputFormat: caseIqOptions ? "json" : "text",
        timeoutSeconds: null,
      };
      await prepareRunArtifacts(paths, snapshot);
      await prisma.$transaction([
        prisma.run.create({
          data: {
            id: runId,
            workId: work.id,
            status: "RUNNING",
            trigger: "TERMINAL_START",
            engine: "CLI",
            providerId: caseIqOptions ? CASEIQ_PROVIDER_ID : null,
            executionPath: work.directoryPath,
            promptSnapshot: prompt,
            attachmentsJson: !caseIqOptions && attachments.length ? JSON.stringify(attachments) : null,
            outputFormat: snapshot.outputFormat,
            agent: snapshot.agent,
            model: snapshot.model,
            fallbackModel: null,
            contextTier: snapshot.contextTier,
            reasoningEffort: snapshot.reasoningEffort,
            permissionMode: snapshot.permissionMode,
            outputDir: paths.outputDirectory,
            logPath: paths.stdout,
            copilotSessionId: sessionId,
            concurrencyMode: "EXTERNAL_TERMINAL",
            baseCommit,
            startedAt,
            hostname: hostname(),
            command,
          },
        }),
        prisma.terminalLaunch.create({
          data: {
            id: launchId,
            runId,
          },
        }),
      ]);

      const launchFile = path.join(
        process.cwd(),
        "data",
        "terminal-launches",
        `${launchId}.json`
      );
      const launcherScript = path.join(process.cwd(), "scripts", "workboard-resume.ps1");
      let launcherPid: number | null;
      try {
        const caseIqSpec: CaseIqTerminalSpec | null = caseIqOptions ? await prepareCaseIqTerminal({
          userId, workId: work.id, workingDirectory: work.directoryPath,
          sessionId, runId, launchId, prompt, launch: caseIqOptions, resume: false,
        }) : null;
        const cliEnvironment = caseIqSpec ? null : buildCopilotEnvironment();
        const cliBridgeArgs = cliEnvironment
          ? resolveSupportIqCliBridgeArgs({
              environment: cliEnvironment,
              workingDirectory: work.directoryPath,
              disabledServers: extractDisabledMcpServersFromArgs(copilotArgs),
              interactiveAuth: true,
            })
          : [];
        const launchEnvironmentOverrides = cliEnvironment
          ? buildTerminalLaunchEnvironmentOverrides(cliEnvironment)
          : undefined;
        if (caseIqOptions) await ensurePrivateRuntimeDirectory(path.dirname(launchFile));
        await mkdir(path.dirname(launchFile), { recursive: true });
        await writeFile(
          launchFile,
          JSON.stringify({
            mode: "new",
            sessionId,
            workingDirectory: work.directoryPath,
            copilotArgs: [...copilotArgs, ...cliBridgeArgs],
            ...(launchEnvironmentOverrides ? { environment: launchEnvironmentOverrides } : {}),
            ...(caseIqSpec ? { providerId: CASEIQ_PROVIDER_ID, caseIqRequestFile: caseIqSpec.requestFile } : {}),
          }),
          { encoding: "utf8", flag: "wx" }
        );
        launcherPid = await spawnDetached(
          "wt.exe",
          [
            "--window",
            "new",
            "new-tab",
            "--startingDirectory",
            work.directoryPath,
            "--title",
            `Work Board ${runId.slice(0, 8)}`,
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            ...(caseIqOptions ? [] : ["-ExecutionPolicy", "Bypass"]),
            "-File",
            caseIqSpec?.script ?? launcherScript,
            ...(caseIqSpec?.arguments ?? ["-LaunchFile", launchFile]),
          ],
          work.directoryPath,
          caseIqSpec?.environment ?? cliEnvironment!
        );
        if (caseIqSpec) monitorCaseIqPreparation(caseIqSpec);
      } catch (error) {
        await prisma.$transaction([
          prisma.terminalLaunch.deleteMany({ where: { id: launchId } }),
          prisma.run.deleteMany({ where: { id: runId } }),
        ]);
        await Promise.all([
          rm(launchFile, { force: true }).catch(() => {}),
          rm(paths.outputDirectory, { recursive: true, force: true }).catch(() => {}),
          rm(getDirectorySnapshotPath(work.directoryPath, runId), { force: true }).catch(() => {}),
        ]);
        throw error;
      }
      await prisma.terminalLaunch.updateMany({
        where: { id: launchId, status: "PENDING" },
        data: { status: "LAUNCHED", launcherPid, launchedAt: new Date() },
      }).catch((error) => {
        console.warn(`[terminal] Run ${runId} opened but launch metadata was not updated:`, error);
      });
      return { runId, launcherPid };
    });
  } catch (error) {
    if (error instanceof RunStartInProgressError) {
      throw new TerminalStartError("A Run is already being started for this Work");
    }
    throw error;
  }
}

export async function tryReadTerminalLaunchExitCode(
  launchId: string
): Promise<number | null> {
  try {
    return await readTerminalLaunchExitCode(launchId);
  } catch {
    return null;
  }
}