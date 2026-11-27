import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { processIsAlive, readCompatibleCopilotSessionEvents } from "@/lib/copilot-session-compat";
import { WINDOWS_PROCESS_START_TIME, windowsProcessMatchesStartTime } from "@/lib/copilot-process";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { getCaseIqInstallation, getCaseIqPromptPowerShell, readOptionalCaseIqText as optionalText } from "@/lib/caseiq-installation";
import type { CaseIqLaunchOptions } from "@/lib/caseiq-options";
import type { CaseIqStartupPhase } from "@/lib/caseiq-startup";
import { getCaseIqSharedOAuthRoot, getCaseIqStateRoot, isPrivateRuntimePath, overlapsPrivateRuntimePath, pathIsWithin } from "@/lib/native-runtime-paths";
import { nativeBindingCompatibilityKey, nativeInvocationRuntimeKey } from "@/lib/native-session-identity";
import {
  caseIqToolPermissionsDirectory, readCaseIqMcpConfiguration, readCaseIqMcpPermissionPolicy,
  requestedMcpTools, writeCaseIqMcpConfiguration,
} from "@/lib/caseiq-tool-permissions-state";
import { newCaseIqMcpConfiguration } from "@/lib/caseiq-mcp-sessions";
import { nativeMcpPermissionRules } from "../../scripts/native-mcp-permissions.mjs";
import { ensureOAuthDirectory, sharedOAuthFailureReason } from "../../scripts/native-shared-oauth.mjs";
import {
  nativeSessionBindingHome, readNativeSessionBindingSync, saveNativeSessionBinding,
} from "@/lib/native-session-bindings";
import {
  NATIVE_BRIDGE_PROTOCOL, assertBridgeCorrelation, bridgeCorrelation,
  launcherResultSchema, nativeBridgeAcceptanceSchema, nativeBridgeFrameSchema, nativeBridgeMcpApprovals, parseNativeBridgeRequest,
} from "../../scripts/native-bridge-protocol.mjs";

const executeFile = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;

export async function ensurePrivateRuntimeDirectory(directory: string): Promise<void> {
  if (!isPrivateRuntimePath(directory)) throw new CaseIqIntegrationError("Runtime storage is outside the private directory.", 500);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    await executeFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-File", path.join(process.cwd(), "scripts", "private-runtime-directory.ps1"),
      "-Directory", directory,
    ], { windowsHide: true, timeout: 15_000 });
  }
}

export interface CaseIqExecutionSpec {
  requestFile: string;
  runId: string;
  sessionId: string;
  script: string;
  arguments: string[];
  environment: Partial<NodeJS.ProcessEnv>;
}

export interface CaseIqTerminalSpec extends CaseIqExecutionSpec {
  launchId: string;
  powerShellExecutable?: string;
}

export interface CaseIqPromptSpec extends CaseIqExecutionSpec {
  powerShellExecutable: string;
}

export interface CaseIqAuthenticationSpec extends CaseIqPromptSpec {
  workId: string;
  terminalFile: string;
}

export async function prepareCaseIqAuthentication(options: {
  userId: string; workId: string; workingDirectory: string; sessionId: string; runId: string;
  testExecutableArgs?: string[];
  trustWorkFolder?: boolean;
}): Promise<CaseIqAuthenticationSpec> {
  const powerShellExecutable = await getCaseIqPromptPowerShell();
  const terminalFile = path.join(getCaseIqStateRoot(), "requests", options.runId, "terminal.json");
  return {
    ...await prepareCaseIqExecution({
      ...options, mode: "terminal", terminalLaunchFile: terminalFile, authenticationOnly: true,
      resume: true, prompt: "", launch: { packs: [], caseNumber: null, sendPrompt: false },
    }),
    powerShellExecutable, terminalFile, workId: options.workId,
  };
}

export async function prepareCaseIqTerminal(options: {
  userId: string; workId: string; workingDirectory: string; sessionId: string;
  runId: string; launchId: string; prompt: string; launch: CaseIqLaunchOptions; resume: boolean;
  sharedInputDirectory?: string;
}): Promise<CaseIqTerminalSpec> {
  const powerShellExecutable = await getCaseIqPromptPowerShell();
  return {
    ...await prepareCaseIqExecution({
      ...options, mode: "terminal",
      terminalLaunchFile: path.join(process.cwd(), "data", "terminal-launches", `${options.launchId}.json`),
    }),
    launchId: options.launchId,
    powerShellExecutable,
  };
}

export async function prepareCaseIqPrompt(options: {
  userId: string; workId: string; workingDirectory: string; sessionId: string;
  runId: string; prompt: string; resume: boolean; attachments?: string[];
  sharedInputDirectory?: string;
  model?: string | null; agent?: string | null; contextTier?: string | null;
  reasoningEffort?: string | null; timeoutMs?: number | null; testExecutableArgs?: string[];
  onStartupStage?: (phase: Extract<CaseIqStartupPhase, "checking" | "session">) => void;
}): Promise<CaseIqPromptSpec> {
  options.onStartupStage?.("checking");
  const powerShellExecutable = await getCaseIqPromptPowerShell();
  return {
    ...await prepareCaseIqExecution({
      ...options, mode: "prompt", terminalLaunchFile: null,
      launch: { packs: [], caseNumber: null, sendPrompt: true },
    }),
    powerShellExecutable,
  };
}

async function prepareCaseIqExecution(options: {
  userId: string; workId: string; workingDirectory: string; sessionId: string;
  runId: string; prompt: string; launch: CaseIqLaunchOptions; resume: boolean;
  mode: "prompt" | "terminal"; terminalLaunchFile: string | null; attachments?: string[];
  authenticationOnly?: boolean;
  trustWorkFolder?: boolean;
  sharedInputDirectory?: string;
  model?: string | null; agent?: string | null; contextTier?: string | null;
  reasoningEffort?: string | null; timeoutMs?: number | null; testExecutableArgs?: string[];
  onStartupStage?: (phase: Extract<CaseIqStartupPhase, "checking" | "session">) => void;
}): Promise<CaseIqExecutionSpec> {
  const installation = await getCaseIqInstallation();
  const requestedWorkingDirectory = options.workingDirectory;
  const workingDirectory = await realpath(/* turbopackIgnore: true */ requestedWorkingDirectory);
  const stateRoot = getCaseIqStateRoot();
  if (pathIsWithin(installation.root, workingDirectory) || pathIsWithin(workingDirectory, stateRoot) ||
      pathIsWithin(installation.root, stateRoot) || isPrivateRuntimePath(workingDirectory)) {
    throw new CaseIqIntegrationError("Use a separate Work directory, outside the CaseIQ installation and private runtime data. The CaseIQ source directory is never a task workspace.");
  }
  const requestedInput = options.sharedInputDirectory;
  const sharedInputDirectory = requestedInput ? await realpath(/* turbopackIgnore: true */ requestedInput) : undefined;
  if (requestedInput && sharedInputDirectory && (path.relative(sharedInputDirectory, workingDirectory) === "" ||
      !pathIsWithin(sharedInputDirectory, workingDirectory) || pathIsWithin(installation.root, sharedInputDirectory) ||
      pathIsWithin(sharedInputDirectory, installation.root) || pathIsWithin(sharedInputDirectory, stateRoot) ||
      overlapsPrivateRuntimePath(sharedInputDirectory) ||
      path.relative(requestedInput, sharedInputDirectory) !== "")) {
    throw new CaseIqIntegrationError("The paired input must contain its output folder and must not overlap CaseIQ or private runtime storage.");
  }
  if (options.launch.packs.some((id) => !installation.packs.some((pack) => pack.id === id))) {
    throw new CaseIqIntegrationError("An unknown CaseIQ support pack was selected.", 400);
  }
  const prior = readNativeSessionBindingSync(options.sessionId);
  if (options.resume && (!prior || !prior.home || prior.userId !== options.userId || prior.workId !== options.workId ||
      prior.hostname !== hostname() || prior.workingDirectory !== workingDirectory ||
      nativeBindingCompatibilityKey(prior) !== nativeBindingCompatibilityKey(installation))) {
    throw new CaseIqIntegrationError("The original CaseIQ owner, installation location or Session binding is unavailable. No other session will be used.");
  }
  const priorEvents = options.mode === "prompt" && options.resume
    ? await readCompatibleCopilotSessionEvents(options.sessionId) : [];
  if (options.mode === "prompt" && options.resume && !priorEvents.length) {
    throw new CaseIqIntegrationError("The original CaseIQ history is unavailable. Start a new CaseIQ Run explicitly; a missing session is never replaced with ordinary CLI.");
  }
  const launch = prior && options.resume ? {
    ...options.launch, packs: prior.packs, caseNumber: prior.caseNumber, sendPrompt: options.mode === "prompt",
  } : options.launch;
  options.onStartupStage?.("session");
  await ensurePrivateRuntimeDirectory(stateRoot);
  const attemptId = randomUUID();
  const directory = options.mode === "prompt"
    ? path.join(stateRoot, "requests", options.runId, attemptId)
    : path.join(stateRoot, "requests", options.runId);
  if (options.mode === "terminal") await ensurePrivateRuntimeDirectory(directory);
  await ensurePrivateRuntimeDirectory(path.join(stateRoot, "bindings"));
  const nativeRoot = path.join(stateRoot, "native", options.sessionId);
  await ensurePrivateRuntimeDirectory(nativeRoot);
  let sharedOAuthRoot: string | null = getCaseIqSharedOAuthRoot(options.userId, installation.launcherPath);
  try {
    await ensureOAuthDirectory(stateRoot, sharedOAuthRoot, ensurePrivateRuntimeDirectory);
  } catch (error) {
    const reason = sharedOAuthFailureReason(error);
    if (reason === null) throw error;
    console.error("[CaseIQ] Shared OAuth unavailable; retaining the original Session cache.", { reason });
    sharedOAuthRoot = null;
  }
  const packagePrefix = path.join(stateRoot, "packages");
  await ensurePrivateRuntimeDirectory(packagePrefix);
  if (options.mode === "prompt" && !await readCaseIqMcpConfiguration(options.userId, options.workId, options.sessionId)) {
    const configuration = await newCaseIqMcpConfiguration(options.userId);
    await ensurePrivateRuntimeDirectory(caseIqToolPermissionsDirectory());
    await writeCaseIqMcpConfiguration(options.userId, options.workId, options.sessionId, configuration);
  }
  const toolPolicy = options.mode === "prompt"
    ? await readCaseIqMcpPermissionPolicy(options.userId, options.workId, options.sessionId,
      requestedMcpTools(priorEvents).map((server) => server.serverName)) : [];
  const request = parseNativeBridgeRequest({
    protocolVersion: NATIVE_BRIDGE_PROTOCOL, requestId: randomUUID(), runId: options.runId,
    attemptId, nonce: randomUUID(),
    launcherPath: installation.launcherPath, launcherSha256: installation.launcherSha256,
    nativeExecutable: installation.nativeExecutable, nativeVersion: installation.nativeVersion,
    sourceCommit: installation.sourceCommit, sourceBranch: installation.sourceBranch ?? null,
    ...(installation.sourceDirty !== undefined ? { sourceDirty: installation.sourceDirty } : {}),
    disableNativeAutoUpdate: true,
    workingDirectory, sessionId: options.sessionId, mode: options.mode, resume: options.resume,
    ...(options.mode === "prompt" ? { trackPromptWrapper: true } : {}),
    ...(sharedInputDirectory ? { sharedInputDirectory } : {}),
    ...(options.authenticationOnly ? { authenticationOnly: true } : {}),
    ...(options.trustWorkFolder ? { trustWorkFolder: true } : {}),
    sharedOAuth: {
      root: sharedOAuthRoot, sessionRoot: nativeRoot,
      boundHome: prior && options.resume ? nativeSessionBindingHome(prior) : null,
    },
    ...(toolPolicy.length ? { mcpToolApprovals: toolPolicy } : {}),
    prompt: options.prompt, sendPrompt: launch.sendPrompt,
    packs: launch.packs, caseNumber: launch.caseNumber,
    terminalLaunchFile: options.terminalLaunchFile,
    attachments: options.attachments ?? [],
    model: options.model ?? null, agent: options.agent ?? null, contextTier: options.contextTier || null,
    reasoningEffort: options.reasoningEffort || null, timeoutMs: options.timeoutMs ?? null,
    handshakeTimeoutMs: options.mode === "prompt" ? 60_000 : 10_000,
    testExecutableArgs: options.testExecutableArgs ?? [],
  });
  const requestFile = path.join(directory, "request.json");
  const requestContent = `${JSON.stringify(request)}\n`;
  if (options.mode === "terminal") await writeFile(requestFile, requestContent, { flag: "wx", mode: 0o600 });
  await saveNativeSessionBinding({
    bindingVersion: 1, providerId: "caseiq", sessionId: options.sessionId,
    userId: options.userId, workId: options.workId, hostname: hostname(), home: prior?.home ?? null,
    ...(prior?.finalHome ? { finalHome: prior.finalHome } : {}),
    ...(prior?.oauthStorage ? { oauthStorage: prior.oauthStorage } : {}),
    launcherPath: installation.launcherPath, launcherSha256: installation.launcherSha256,
    sourceCommit: installation.sourceCommit, nativeExecutable: installation.nativeExecutable,
    nativeVersion: installation.nativeVersion, workingDirectory, packs: launch.packs, caseNumber: launch.caseNumber,
  });
  if (options.mode === "prompt") {
    // Recovery enumerates only attempts whose whole request has been published.
    const staging = path.join(/* turbopackIgnore: true */ stateRoot, "request-staging", attemptId);
    const stagedFile = path.join(staging, "request.json");
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await ensurePrivateRuntimeDirectory(staging);
    try {
      await writeFile(stagedFile, requestContent, { flag: "wx", mode: 0o600 });
      await rename(staging, directory);
    } catch (error) {
      try {
        await rm(stagedFile, { force: true });
        await rmdir(staging);
      } catch (cleanupError) {
        console.error("[CaseIQ] Could not remove an unpublished request.", attemptId, cleanupError);
      }
      throw error;
    }
  }
  return {
    requestFile, runId: options.runId, sessionId: options.sessionId,
    script: path.join(process.cwd(), "scripts", "workboard-caseiq.ps1"),
    arguments: ["-RequestFile", requestFile, "-NodeExecutable", process.execPath],
    environment: {
      CASEIQ_HOME: path.join(nativeRoot, "home"), CASEIQ_CASES_ROOT: path.join(nativeRoot, "cases"),
      npm_config_prefix: packagePrefix,
      npm_config_cache: path.join(stateRoot, "npm-cache"),
      PATH: `${packagePrefix}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
    },
  };
}

export async function acceptCaseIqPreparation(run: {
  id: string; workId: string | null; copilotSessionId: string | null;
}, launchId: string | null, promptRequestFile?: string, canAcceptPrompt?: () => boolean): Promise<boolean> {
  return acceptCaseIqInvocation(run, launchId, promptRequestFile, undefined, canAcceptPrompt);
}

export async function acceptCaseIqAuthentication(
  spec: CaseIqAuthenticationSpec, authorize: () => Promise<void>,
): Promise<boolean> {
  return acceptCaseIqInvocation({
    id: spec.runId, workId: spec.workId, copilotSessionId: spec.sessionId,
  }, null, undefined, authorize);
}

async function acceptCaseIqInvocation(run: {
  id: string; workId: string | null; copilotSessionId: string | null;
}, launchId: string | null, promptRequestFile?: string, authorizeAuthentication?: () => Promise<void>,
canAcceptPrompt?: () => boolean): Promise<boolean> {
  if (!run.copilotSessionId) throw new CaseIqIntegrationError("CaseIQ session ID is missing.");
  const binding = readNativeSessionBindingSync(run.copilotSessionId);
  if (!binding || binding.workId !== run.workId) throw new CaseIqIntegrationError("CaseIQ binding is missing.");
  const runDirectory = path.join(getCaseIqStateRoot(), "requests", run.id);
  const directory = promptRequestFile ? path.dirname(promptRequestFile) : runDirectory;
  if (!pathIsWithin(runDirectory, directory)) throw new CaseIqIntegrationError("CaseIQ preparation is outside its Run.");
  const requestFile = path.join(directory, "request.json");
  const request = parseNativeBridgeRequest(JSON.parse(await readFile(/* turbopackIgnore: true */ requestFile, "utf8")));
  if (Boolean(request.authenticationOnly) !== Boolean(authorizeAuthentication)) {
    throw new CaseIqIntegrationError("The CaseIQ invocation requires its original execution owner.");
  }
  if (request.runId !== run.id || request.sessionId !== run.copilotSessionId ||
      (promptRequestFile && request.mode !== "prompt")) {
    throw new CaseIqIntegrationError("CaseIQ preparation does not belong to this Run.");
  }
  const priorAcceptance = await optionalText(path.join(directory, "accept.json"));
  if (priorAcceptance !== null) {
    const acceptance = z.object({
      protocolVersion: z.literal(NATIVE_BRIDGE_PROTOCOL), requestId: z.string(), runId: z.string(),
      attemptId: z.string(), nonce: z.string(), action: z.literal("accept"), preparedHash: z.string().regex(SHA256),
    }).strict().parse(JSON.parse(priorAcceptance));
    assertBridgeCorrelation(acceptance, request);
    if (!authorizeAuthentication && await optionalText(path.join(directory, "launcher-result.json")) !== null) {
      await finalizeCaseIqSessionHome(run, requestFile);
    }
    return true;
  }
  const content = await optionalText(path.join(directory, "journal.jsonl"));
  if (content === null) return false;
  const complete = content.slice(0, content.lastIndexOf("\n") + 1);
  const events = complete.split("\n").filter(Boolean).map((line) => nativeBridgeFrameSchema.parse(JSON.parse(line)));
  for (const event of events) assertBridgeCorrelation(event, request);
  const prepared = events.find((event) => event.kind === "prepared");
  if (!prepared) return false;
  const installation = await getCaseIqInstallation();
  if (nativeInvocationRuntimeKey(installation) !== nativeInvocationRuntimeKey(request)) {
    throw new CaseIqIntegrationError("The launcher or CLI executable changed within this startup attempt. Start a new Run so its observed runtime metadata matches the actual invocation.");
  }
  const nativeRootPath = path.join(getCaseIqStateRoot(), "native", binding.sessionId);
  const nativeRoot = await realpath(/* turbopackIgnore: true */ nativeRootPath);
  const preparedHome = prepared.binding.home;
  const home = await realpath(/* turbopackIgnore: true */ preparedHome);
  if (!pathIsWithin(nativeRoot, home) || !(await stat(/* turbopackIgnore: true */ home)).isDirectory() ||
      prepared.binding.sessionId !== binding.sessionId ||
      nativeSessionBindingHome(binding) !== null && nativeSessionBindingHome(binding) !== home) {
    throw new CaseIqIntegrationError("CaseIQ prepared an unexpected session home.");
  }
  for (const required of ["telemetry", "runtime", path.join("support-packs", "platform")]) {
    if (!prepared.binding.pluginDirectories.includes(path.join(path.dirname(binding.launcherPath), required))) {
      throw new CaseIqIntegrationError("The native launcher did not include a required CaseIQ plugin. No task was started.");
    }
  }
  await saveNativeSessionBinding({
    ...binding, home: binding.home ?? home, oauthStorage: prepared.binding.oauthStorage,
  });
  if (authorizeAuthentication) {
    await authorizeAuthentication();
  } else {
    if (request.mode === "prompt") {
      const observed = request.resume
        ? requestedMcpTools(await readCompatibleCopilotSessionEvents(binding.sessionId, home)) : [];
      const policy = await readCaseIqMcpPermissionPolicy(binding.userId, binding.workId, binding.sessionId,
        observed.map((server) => server.serverName));
      const rules = nativeMcpPermissionRules(policy);
      if (JSON.stringify(policy) !== JSON.stringify(nativeBridgeMcpApprovals(request)) ||
          rules.some((rule) => !prepared.binding.allowTools.includes(rule))) {
        throw new CaseIqIntegrationError("MCP tool approvals changed or were not included in the prepared invocation. No Prompt was replayed.", 409);
      }
    }
    const updated = await prisma.run.updateMany({
      where: { id: run.id, providerId: "caseiq", status: "RUNNING", copilotSessionId: binding.sessionId },
      data: { model: prepared.binding.model },
    });
    if (!updated.count) throw new CaseIqIntegrationError("This CaseIQ Run no longer owns its startup request.");
  }
  const acceptance = { ...bridgeCorrelation(request), action: "accept", preparedHash: prepared.binding.preparedHash };
  const file = path.join(directory, "accept.json");
  const prior = await optionalText(file);
  if (prior === null) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(acceptance), { flag: "wx", mode: 0o600 });
    if (canAcceptPrompt) {
      if (!canAcceptPrompt()) {
        await rm(temporary);
        return false;
      }
      // Check cancellation and publish permission to spawn in the same event-loop turn.
      renameSync(temporary, file);
    } else {
      await rename(temporary, file);
    }
  } else if (JSON.stringify(JSON.parse(prior)) !== JSON.stringify(acceptance)) {
    throw new CaseIqIntegrationError("A different CaseIQ startup acknowledgement already exists.");
  }
  if (launchId !== null) {
    await prisma.terminalLaunch.updateMany({
      where: { id: launchId, runId: run.id }, data: { errorMessage: null },
    });
  }
  return true;
}

export async function finalizeCaseIqSessionHome(run: {
  id: string; workId: string | null; copilotSessionId: string | null;
}, requestFile: string): Promise<void> {
  if (!run.copilotSessionId) throw new CaseIqIntegrationError("CaseIQ session ID is missing.");
  const binding = readNativeSessionBindingSync(run.copilotSessionId);
  if (!binding?.home || binding.workId !== run.workId) throw new CaseIqIntegrationError("CaseIQ binding is missing.");
  const directory = path.dirname(requestFile);
  if (!pathIsWithin(path.join(getCaseIqStateRoot(), "requests", run.id), directory) ||
      path.basename(requestFile) !== "request.json") {
    throw new CaseIqIntegrationError("CaseIQ finalization is outside its Run.");
  }
  const request = parseNativeBridgeRequest(JSON.parse(await readFile(/* turbopackIgnore: true */ requestFile, "utf8")));
  const acceptance = nativeBridgeAcceptanceSchema.parse(JSON.parse(await readFile(path.join(directory, "accept.json"), "utf8")));
  const launcher = launcherResultSchema.parse(JSON.parse(await readFile(path.join(directory, "launcher-result.json"), "utf8")));
  const native = nativeBridgeFrameSchema.parse(JSON.parse(await readFile(path.join(directory, "native-result.json"), "utf8")));
  assertBridgeCorrelation(acceptance, request);
  assertBridgeCorrelation(launcher, request);
  assertBridgeCorrelation(native, request);
  if (request.runId !== run.id || request.sessionId !== binding.sessionId || native.kind !== "native-result" ||
      !launcher.nativeExecutionObserved || native.pid === null || launcher.scriptError || native.error ||
      launcher.nativeExitCode !== native.exitCode ||
      path.relative(request.launcherPath, binding.launcherPath) !== "" ||
      path.relative(request.nativeExecutable, binding.nativeExecutable) !== "" ||
      path.relative(request.workingDirectory, binding.workingDirectory) !== "") {
    throw new CaseIqIntegrationError("CaseIQ finalization has no matching completed native invocation.");
  }
  if (binding.finalHome) return;
  const originalEvents = path.join(binding.home, "session-state", binding.sessionId, "events.jsonl");
  const original = await stat(/* turbopackIgnore: true */ originalEvents).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (original?.isFile() && original.size > 0) return;
  // CaseIQ renames only this newly launched home to its exact Copilot session ID.
  const expected = path.join(path.dirname(binding.home), binding.sessionId);
  const missingHistory = () => {
    if (request.mode === "prompt" && native.exitCode === 0) {
      throw new CaseIqIntegrationError("CaseIQ completed but its exact session history is missing. No alternative home will be selected.");
    }
  };
  if (path.relative(binding.home, expected) === "") { missingHistory(); return; }
  const entry = await lstat(/* turbopackIgnore: true */ expected).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (entry === null) { missingHistory(); return; }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new CaseIqIntegrationError("CaseIQ final home is not a regular session directory.");
  }
  const finalHome = await realpath(/* turbopackIgnore: true */ expected);
  const nativeRootPath = path.join(getCaseIqStateRoot(), "native", binding.sessionId);
  const nativeRoot = await realpath(/* turbopackIgnore: true */ nativeRootPath);
  if (!pathIsWithin(nativeRoot, finalHome) ||
      path.relative(path.dirname(binding.home), path.dirname(finalHome)) !== "") {
    throw new CaseIqIntegrationError("CaseIQ final home escaped its original session namespace.");
  }
  if (!(await readCompatibleCopilotSessionEvents(binding.sessionId, finalHome)).length) {
    throw new CaseIqIntegrationError("The renamed CaseIQ home has no history for the same session.");
  }
  await saveNativeSessionBinding({ ...binding, finalHome });
}

const globalForCaseIq = globalThis as unknown as { caseIqPreparationMonitors?: Set<string> };
const monitors = globalForCaseIq.caseIqPreparationMonitors ??= new Set<string>();

export function monitorCaseIqPreparation(spec: CaseIqTerminalSpec): void {
  if (monitors.has(spec.runId)) return;
  monitors.add(spec.runId);
  void (async () => {
    const deadline = Date.now() + 120_000;
    let nextIdentityCheck = deadline;
    while (true) {
      const metadata = await optionalText(path.join(/* turbopackIgnore: true */ process.cwd(), "data", "terminal-launches", `${spec.launchId}.json`));
      const state = metadata === null ? null : z.object({
        wrapperPid: z.number().int().positive().optional(),
        wrapperStartTime: z.string().regex(WINDOWS_PROCESS_START_TIME).optional(),
        exitCode: z.number().optional(),
      }).parse(JSON.parse(metadata));
      if (state?.wrapperStartTime && !state.wrapperPid) throw new CaseIqIntegrationError("CaseIQ wrapper creation identity is incomplete.");
      if (state?.exitCode !== undefined) return;
      if (await acceptCaseIqPreparation({ id: spec.runId, workId: readNativeSessionBindingSync(spec.sessionId)?.workId ?? null, copilotSessionId: spec.sessionId }, spec.launchId)) return;
      if (Date.now() >= nextIdentityCheck) {
        nextIdentityCheck = Date.now() + 5000;
        const alive = state?.wrapperPid && processIsAlive(state.wrapperPid) &&
          (!state.wrapperStartTime || await windowsProcessMatchesStartTime(state.wrapperPid, state.wrapperStartTime));
        if (!alive) {
          throw new CaseIqIntegrationError("CaseIQ Terminal did not start its wrapper or the original wrapper has exited. Check Windows Terminal and PowerShell execution policy.");
        }
      }
      await sleep(250);
    }
  })().catch(async (error: unknown) => {
    console.error("[CaseIQ] Native startup could not be accepted.", error);
    try {
      await prisma.terminalLaunch.updateMany({
        where: { id: spec.launchId, runId: spec.runId },
        data: { errorMessage: error instanceof CaseIqIntegrationError ? error.message : "CaseIQ native startup failed. Inspect the native Terminal and server diagnostics." },
      });
    } catch (persistenceError) {
      console.error("[CaseIQ] Startup failure could not be persisted.", persistenceError);
    }
  }).finally(() => { monitors.delete(spec.runId); });
}
