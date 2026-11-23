import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { ChildProcess, spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateRun: vi.fn(), updateTerminal: vi.fn(), initialConfiguration: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("@/lib/copilot-process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./copilot-process")>();
  return { ...actual, stopCopilotProcess: vi.fn(actual.stopCopilotProcess) };
});
vi.mock("@/lib/copilot-session-insights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./copilot-session-insights")>();
  return { ...actual, readCopilotSessionInsights: vi.fn(actual.readCopilotSessionInsights) };
});
vi.mock("@/lib/caseiq-mcp-sessions", () => ({ newCaseIqMcpConfiguration: mocks.initialConfiguration }));
vi.mock("@/lib/prisma", () => ({
  prisma: { run: { updateMany: mocks.updateRun }, terminalLaunch: { updateMany: mocks.updateTerminal } },
}));
vi.mock("@/lib/caseiq-installation", async (importOriginal) => ({
  ...await importOriginal<typeof import("./caseiq-installation")>(),
  getCaseIqInstallation: vi.fn(),
}));
import { getCaseIqInstallation, type CaseIqInstallation } from "./caseiq-installation";
import { CaseIqRunUnconfirmedError } from "./caseiq-errors";
import { buildCaseIqEnvironment, startCaseIqRun } from "./caseiq-runner";
import { stopCopilotProcess } from "./copilot-process";
import {
  cancelRun, getRunEmitter, getRunLogPath, INCOMPLETE_SESSION_PROMPT, isNativeCopilotRunActive,
  type CopilotRunEvent,
} from "./copilot-runner";
import { processIsAlive } from "./copilot-session-compat";
import { readCopilotSessionInsights } from "./copilot-session-insights";
import { readNativeSessionBindingSync } from "./native-session-bindings";
import { acceptCaseIqAuthentication, acceptCaseIqPreparation, prepareCaseIqAuthentication } from "./caseiq-integration";
import { caseIqAuthenticationActivity } from "./caseiq-authentication-state";
import { caseIqToolPermissionsDirectory, writeCaseIqMcpApprovals, writeCaseIqToolApprovals } from "./caseiq-tool-permissions-state";
import { getCaseIqStartup } from "./caseiq-startup-state";
import {
  authorizeCaseIqRunLaunch, inspectInterruptedCaseIqRun, persistCaseIqPrelaunchCancellation, prepareCaseIqRunLaunch,
} from "./caseiq-run-lifecycle";
import type { CaseIqRunVersion } from "./run-artifacts";
import { bridgeCorrelation, parseNativeBridgeRequest } from "../../scripts/native-bridge-protocol.mjs";

let root: string;
let state: string;
let configuration: string;
let record: string;
let installation: CaseIqInstallation;
let defaults: Parameters<typeof startCaseIqRun>[0];
const running = new Map<string, ReturnType<typeof startCaseIqRun>>();
let runIds: string[];

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.updateRun.mockResolvedValue({ count: 1 });
  mocks.initialConfiguration.mockResolvedValue({
    origin: "settings", defaults: { defaultAutoApprove: false, servers: [] }, servers: [],
  });
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-web-"));
  state = path.join(root, "private-runtime");
  const installed = path.join(root, "installation");
  const work = path.join(root, "work");
  await Promise.all(["telemetry", "runtime", path.join("support-packs", "platform")].map((directory) =>
    mkdir(path.join(installed, directory), { recursive: true })));
  await mkdir(work);
  const launcher = path.join(installed, "caseiq.ps1");
  await copyFile(path.join(process.cwd(), "src", "lib", "__fixtures__", "caseiq-web-launcher.ps1"), launcher);
  installation = {
    root: installed, launcherPath: launcher,
    launcherSha256: createHash("sha256").update(await readFile(launcher)).digest("hex"),
    sourceCommit: "a".repeat(40), nativeExecutable: process.execPath, nativeVersion: "1.0.105",
    packs: [{ id: "platform", name: "Synthetic platform" }],
  };
  vi.mocked(getCaseIqInstallation).mockResolvedValue(installation);
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", state);
  vi.stubEnv("COPILOT_HOME", path.join(root, "unrelated-global-home"));
  configuration = path.join(root, "configuration.json");
  record = path.join(root, "native-record.jsonl");
  await writeFile(configuration, JSON.stringify({ record, mode: "complete" }));
  defaults = {
    userId: "owner", workId: "work", runId: randomUUID(), sessionId: randomUUID(),
    authorizeLaunch: async () => "authorized",
    persistPrelaunchCancellation: async () => {},
    repoPath: work, prompt: "User-owned Prompt\nPreserve whitespace and \u4e2d\u6587.",
    outputFormat: "json", timeoutSeconds: null,
    stdoutLogPath: path.join(root, "artifacts", "stdout.log"),
    stderrLogPath: path.join(root, "artifacts", "stderr.log"),
    testExecutableArgs: [
      path.join(process.cwd(), "src", "lib", "__fixtures__", "caseiq-web-native.mjs"), configuration,
    ],
  };
  runIds = [];
});

afterEach(async () => {
  for (const id of running.keys()) await cancelRun(id);
  await Promise.allSettled([...running.values()]);
  vi.unstubAllEnvs();
  for (const id of runIds) await rm(getRunLogPath(id), { force: true });
  await rm(root, { recursive: true, force: true });
});

function run(overrides: Partial<typeof defaults> = {}) {
  const options = { ...defaults, ...overrides };
  runIds.push(options.runId);
  const result = startCaseIqRun(options);
  running.set(options.runId, result);
  void result.finally(() => { running.delete(options.runId); }).catch(() => {});
  return result;
}

async function scenario(mode: string) {
  await writeFile(configuration, JSON.stringify({ record, mode, privatePath: state, outputReady: path.join(root, "output-ready") }));
}

function syntheticWrapper() {
  return Object.assign(new ChildProcess(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
}

async function records(): Promise<{ prompt: string; args: string[]; home: string; cwd: string; instructions: string | null; pid: number; sessionId: string; resumed: boolean }[]> {
  const text = await readFile(record, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForNative(pending: ReturnType<typeof startCaseIqRun>) {
  const deadline = Date.now() + 20_000;
  let ended = false;
  let failure: unknown;
  void pending.then(() => { ended = true; }, (error: unknown) => { ended = true; failure = error; });
  while (!(await records()).length) {
    if (ended) throw failure ?? new Error("CaseIQ exited before the synthetic native CLI started.");
    if (Date.now() >= deadline) throw new Error("Synthetic CaseIQ native CLI did not start.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.runIf(process.platform === "win32")("CaseIQ web runtime through the original-launcher bridge", () => {
  it("keeps the original launcher and paired output folder for initial and resumed native invocations", async () => {
    const cwd = path.join(defaults.repoPath, "caseiq");
    await mkdir(cwd);
    const pairedWorkspace = { inputDirectory: defaults.repoPath, instructionDirectory: path.join(state, "paired-instructions") };
    await mkdir(pairedWorkspace.instructionDirectory, { recursive: true });
    await writeFile(path.join(pairedWorkspace.instructionDirectory, "fixture.instructions.md"), "Use the fixture output folder.");
    expect(await run({ repoPath: cwd, pairedWorkspace })).toMatchObject({ exitCode: 0 });
    expect(await run({ runId: randomUUID(), repoPath: cwd, pairedWorkspace, resumeSession: true })).toMatchObject({ exitCode: 0 });
    const invocations = await records();
    expect(invocations).toHaveLength(2);
    expect(invocations.map(({ resumed }) => resumed)).toEqual([false, true]);
    for (const invocation of invocations) {
      const inputFlag = invocation.args.indexOf("--add-dir");
      expect(inputFlag).toBeGreaterThanOrEqual(0);
      expect(invocation.args[inputFlag + 1]).toBe(defaults.repoPath);
      expect(invocation).toMatchObject({ cwd, prompt: defaults.prompt, sessionId: defaults.sessionId });
      expect(invocation.args).toContain("--plugin-dir");
      expect(invocation.instructions?.split(path.delimiter)).toContain(pairedWorkspace.instructionDirectory);
    }
  }, 60_000);

  it("reuses one OAuth directory across different Works and resumed Sessions, but not different owners", async () => {
    expect(await run()).toMatchObject({ exitCode: 0 });
    const first = readNativeSessionBindingSync(defaults.sessionId)!;
    expect(first.oauthStorage?.mode).toBe("shared");
    const firstOAuth = path.join(first.home!, "mcp-oauth-config");
    await writeFile(path.join(firstOAuth, "shared.marker"), "synthetic OAuth state, not a token");
    const otherWork = path.join(root, "second-work");
    await mkdir(otherWork);
    const secondSession = randomUUID();
    expect(await run({ runId: randomUUID(), sessionId: secondSession, workId: "second-work", repoPath: otherWork }))
      .toMatchObject({ exitCode: 0 });
    const second = readNativeSessionBindingSync(secondSession)!;
    expect(second.home).not.toBe(first.home);
    expect(second.oauthStorage).toEqual(first.oauthStorage);
    const secondOAuth = path.join(second.home!, "mcp-oauth-config");
    expect(await realpath(secondOAuth)).toBe(await realpath(firstOAuth));
    expect(await readFile(path.join(secondOAuth, "shared.marker"), "utf8")).toContain("synthetic OAuth state");
    expect(await run({ runId: randomUUID(), resumeSession: true })).toMatchObject({ exitCode: 0 });
    expect(await realpath(firstOAuth)).toBe(await realpath(secondOAuth));
    expect(await readFile(path.join(firstOAuth, "shared.marker"), "utf8")).toContain("synthetic OAuth state");
    const foreignSession = randomUUID();
    expect(await run({ runId: randomUUID(), sessionId: foreignSession, userId: "another-owner" })).toMatchObject({ exitCode: 0 });
    const foreign = readNativeSessionBindingSync(foreignSession)!;
    expect(await realpath(path.join(foreign.home!, "mcp-oauth-config"))).not.toBe(await realpath(firstOAuth));
    expect(await readdir(path.join(foreign.home!, "mcp-oauth-config"))).toEqual([]);
    expect((await records()).map((record) => record.prompt)).toEqual([
      defaults.prompt, defaults.prompt, defaults.prompt, defaults.prompt,
    ]);
    expect((await records()).map((record) => record.resumed)).toEqual([false, false, true, false]);
  }, 90_000);

  it("keeps normal execution available with an explicit local-cache warning when a shared profile cannot be identified", async () => {
    await writeFile(configuration, JSON.stringify({
      record, mode: "complete", supportIqUrl: "${SYNTHETIC_UNRESOLVED_ENDPOINT}",
    }));
    expect(await run()).toMatchObject({ exitCode: 0, incomplete: false });
    expect(readNativeSessionBindingSync(defaults.sessionId)?.oauthStorage).toMatchObject({
      mode: "session", reason: "supportiq-profile-unavailable",
    });
    expect(await readFile(defaults.stderrLogPath!, "utf8")).toContain("Shared OAuth unavailable (supportiq-profile-unavailable)");
    expect(await records()).toHaveLength(1);
  }, 30_000);

  it("accepts a separate authentication invocation without a DB Run, Prompt or SDK session", async () => {
    expect(await run()).toMatchObject({ exitCode: 0 });
    expect(await readFile(defaults.stdoutLogPath!, "utf8")).not.toContain("ACTION REQUIRED: SUPPORTIQ SIGN-IN ONLY");
    const before = readNativeSessionBindingSync(defaults.sessionId);
    const authId = randomUUID();
    const authRecord = path.join(root, "authentication-native.jsonl");
    const authConfiguration = path.join(root, "authentication.json");
    await writeFile(authConfiguration, JSON.stringify({ record: authRecord, mode: "authentication-only" }));
    const spec = await prepareCaseIqAuthentication({
      userId: defaults.userId, workId: defaults.workId, workingDirectory: defaults.repoPath,
      sessionId: defaults.sessionId, runId: authId,
      testExecutableArgs: [path.join(process.cwd(), "src", "lib", "__fixtures__", "caseiq-authentication-native.mjs"), authConfiguration],
    });
    await writeFile(spec.terminalFile, JSON.stringify({ mode: "authentication", sessionId: spec.sessionId }));
    const dto = { id: authId, workId: defaults.workId, copilotSessionId: defaults.sessionId };
    await expect(acceptCaseIqPreparation(dto, null)).rejects.toThrow("execution owner");
    mocks.updateRun.mockClear();
    const child = spawn(spec.powerShellExecutable, ["-NoLogo", "-NoProfile", "-File", spec.script, ...spec.arguments], {
      cwd: defaults.repoPath, env: { ...buildCaseIqEnvironment(), ...spec.environment }, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    child.stdout.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const authorize = vi.fn(async () => {});
    try {
      const deadline = Date.now() + 20_000;
      while (!await acceptCaseIqAuthentication(spec, authorize)) {
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`Authentication preparation failed: ${diagnostic}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await closed).toBe(0);
      expect(authorize).toHaveBeenCalledOnce();
      expect(mocks.updateRun).not.toHaveBeenCalled();
      const captured = JSON.parse((await readFile(authRecord, "utf8")).trim());
      expect(captured.args).toContain(`--resume=${defaults.sessionId}`);
      expect(captured.prompt).toBeNull();
      expect(captured.args).not.toContain("-p");
      expect(captured.args).not.toContain("-i");
      expect(captured.args).not.toContain("/mcp auth SupportIQ");
      expect(diagnostic.match(/ACTION REQUIRED: SUPPORTIQ SIGN-IN ONLY/g)).toHaveLength(2);
      expect(diagnostic).toContain("TSE account on the official sign-in page");
      expect(diagnostic).toContain("DO NOT SEND TASK PROMPTS IN THIS WINDOW.");
      expect(before?.oauthStorage?.mode).toBe("shared");
      expect(readNativeSessionBindingSync(defaults.sessionId)).toEqual(before);
      expect(await caseIqAuthenticationActivity({
        id: authId, sessionId: spec.sessionId, sourceRunId: defaults.runId, startedAt: new Date().toISOString(),
        userId: defaults.userId, workId: defaults.workId, hostname: before!.hostname,
        launchRejected: false, errorMessage: null, trustWorkFolder: false,
      })).toMatchObject({ status: "closed", reserved: false, message: expect.stringContaining("not yet independently verified") });
    } finally {
      if (child.exitCode === null) { await import("./copilot-process").then(({ stopCopilotProcess }) => stopCopilotProcess(child)); await closed; }
    }
  }, 40_000);

  it("assembles split native JSON and masks private paths before emitting complete lines", async () => {
    await scenario("split-output");
    const events: CopilotRunEvent[] = [];
    const pending = run();
    getRunEmitter(defaults.runId)!.on("event", (event: CopilotRunEvent) => { events.push(event); });
    expect(await pending).toMatchObject({ exitCode: 0, incomplete: false });
    const lines = events.flatMap((event) => event.type === "line" ? [event.data] : []);
    const jsonLines = lines.filter((line) => line.startsWith("{"));
    expect(jsonLines.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "assistant.message", data: expect.objectContaining({ content: "Synthetic split \u4e2d\u6587" }) }),
    ]));
    const escapedState = JSON.stringify(state).slice(1, -1);
    for (const text of [lines.join("\n"), await readFile(defaults.stdoutLogPath!, "utf8"), await readFile(defaults.stderrLogPath!, "utf8")]) {
      expect(text.toLowerCase()).not.toContain(state.toLowerCase());
      expect(text.toLowerCase()).not.toContain(escapedState.toLowerCase());
    }
    expect(lines).toContain("Synthetic split diagnostic at <private CaseIQ>");
    expect(lines.filter((line) => line.includes("Synthetic split diagnostic"))).toHaveLength(1);
  }, 30_000);

  it("reports output persistence failure through the live stream instead of silently losing the error", async () => {
    const blocked = path.join(root, "blocked-output.log");
    await mkdir(blocked);
    const events: CopilotRunEvent[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = run({ stdoutLogPath: blocked });
      getRunEmitter(defaults.runId)!.on("event", (event: CopilotRunEvent) => { events.push(event); });
      await expect(pending).rejects.toThrow("output could not be saved");
      expect(events).toContainEqual({ type: "error", message: expect.stringContaining("output could not be saved") });
      expect(events.some((event) => event.type === "exit" && event.code === 0)).toBe(false);
      expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
      expect(logged).toHaveBeenCalledWith("[CaseIQ] Run output could not be persisted.", expect.any(Error));
    } finally { logged.mockRestore(); }
  }, 30_000);

  it("rejects a duplicate Run without replacing the active Run's emitter or cancellation control", async () => {
    await scenario("wait");
    const pending = run();
    const emitter = getRunEmitter(defaults.runId);
    await waitForNative(pending);
    await expect(startCaseIqRun(defaults)).rejects.toThrow("already owns");
    expect(getRunEmitter(defaults.runId)).toBe(emitter);
    expect(await cancelRun(defaults.runId)).toBe(true);
    expect(await pending).toMatchObject({ cancelled: true });
  }, 30_000);

  it("stops the owned native process if output persistence fails while it is running", async () => {
    await scenario("wait-output");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events: CopilotRunEvent[] = [];
      const pending = run();
      getRunEmitter(defaults.runId)!.on("event", (event: CopilotRunEvent) => { events.push(event); });
      await waitForNative(pending);
      const [native] = await records();
      const deadline = Date.now() + 20_000;
      while (!(await readFile(defaults.stdoutLogPath!, "utf8")).includes('"type":"tool.execution_start"')) {
        if (Date.now() >= deadline) throw new Error("Synthetic startup output was not persisted.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await rename(defaults.stdoutLogPath!, path.join(root, "original-stdout.log"));
      await mkdir(defaults.stdoutLogPath!);
      await writeFile(path.join(root, "output-ready"), "ready");
      await expect(pending).rejects.toThrow("output could not be saved");
      expect(events).toContainEqual({ type: "error", message: expect.stringContaining("output could not be saved") });
      expect(processIsAlive(native.pid)).toBe(false);
      expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
      expect(logged).toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  }, 30_000);

  it("preserves approved CaseIQ host auth settings without forwarding WorkBoard secrets", () => {
    const environment = buildCaseIqEnvironment({
      NODE_ENV: "test",
      GH_CONFIG_DIR: "C:\\synthetic-gh-profile",
      COPILOT_ENTRA_DISABLE_ONEAUTH: "0",
      COPILOT_ENTRA_ONEAUTH: "1",
      COPILOT_ENTRA_ONEAUTH_SCOPE_BINDING_MODE: "synthetic-approved-mode",
      AUTH_SECRET: "synthetic-workboard-secret", DATABASE_URL: "synthetic-private-database",
      WORKBOARD_CASEIQ_ROOT: "C:\\not-a-child-setting",
    });

    expect(environment).toMatchObject({
      GH_CONFIG_DIR: "C:\\synthetic-gh-profile", COPILOT_ENTRA_DISABLE_ONEAUTH: "0",
      COPILOT_ENTRA_ONEAUTH: "1",
      COPILOT_ENTRA_ONEAUTH_SCOPE_BINDING_MODE: "synthetic-approved-mode",
    });
    expect(environment).not.toHaveProperty("AUTH_SECRET");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("WORKBOARD_CASEIQ_ROOT");
  });
  it("does not replace an empty user Prompt with a synthetic task", async () => {
    await expect(run({ prompt: "   " })).rejects.toThrow("Enter a Prompt or attach files");
    expect(await records()).toEqual([]);
    expect(getCaseIqInstallation).not.toHaveBeenCalled();
  });
  it("runs the exact user Prompt with required plugins, private history and no Terminal", async () => {
    const events: CopilotRunEvent[] = [];
    const pending = run();
    getRunEmitter(defaults.runId)!.on("event", (event: CopilotRunEvent) => { events.push(event); });
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false, incomplete: false, model: "synthetic-default" });
    expect(result.finalOutput).toBe(`Synthetic CaseIQ response: ${defaults.prompt}`);
    const [native] = await records();
    expect(native.prompt).toBe(defaults.prompt);
    expect(native.args).toEqual(expect.arrayContaining(["--output-format", "json", "--stream", "on"]));
    expect(native.args.some((argument) => argument.startsWith("--allow-all"))).toBe(false);
    expect(native.home).toBe(readNativeSessionBindingSync(defaults.sessionId)?.home);
    expect(native.home).not.toContain("unrelated-global-home");
    const attempts = await readdir(path.join(state, "requests", defaults.runId));
    const request = JSON.parse(await readFile(path.join(state, "requests", defaults.runId, attempts[0], "request.json"), "utf8"));
    expect(request).toMatchObject({ mode: "prompt", terminalLaunchFile: null, prompt: defaults.prompt });
    expect(mocks.updateTerminal).not.toHaveBeenCalled();
    expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
    const generated = path.join(state, "native", defaults.sessionId, "home", "generated",
      `long-path-${"x".repeat(100)}`, "pack-instructions", "platform--customer-content-protected-material.instructions.md");
    expect(generated.length).toBeGreaterThan(260);
    expect(await readFile(generated, "utf8")).toBe("Synthetic long-path instructions");
    const lines = events.flatMap((event) => event.type === "line" ? [event.data] : []);
    expect(lines[0]).toContain("Preparing CaseIQ to run your Prompt");
    const accepted = lines.findIndex((line) => line.includes("CaseIQ preparation accepted"));
    const spawned = lines.findIndex((line) => line.includes("CaseIQ Prompt process started"));
    const nativeLine = lines.findIndex((line) => line.includes('"type":"user.message"'));
    expect(accepted).toBeGreaterThan(0);
    expect(spawned).toBeGreaterThan(accepted);
    expect(nativeLine).toBeGreaterThan(spawned);
  }, 30_000);

  it("resumes web Follow Up in the same CaseIQ home and session", async () => {
    const first = await run();
    const second = await run({ runId: randomUUID(), prompt: "My own follow-up", resumeSession: true, model: first.model });
    expect(second).toMatchObject({ exitCode: 0, incomplete: false });
    const native = await records();
    expect(native).toHaveLength(2);
    expect(native[1]).toMatchObject({ prompt: "My own follow-up", resumed: true, home: native[0].home, sessionId: native[0].sessionId });
  }, 45_000);

  it("reports failed version metadata persistence before starting any native process", async () => {
    const onVersion = vi.fn(async () => { throw new Error("Synthetic version metadata write failed."); });
    await expect(run({ onVersion })).rejects.toThrow("version metadata write failed");
    expect(onVersion).toHaveBeenCalledOnce();
    expect(await records()).toEqual([]);
    expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
  }, 30_000);

  it("does not spawn after a cancellation received while recording the version", async () => {
    const onVersion = async () => { expect(await cancelRun(defaults.runId)).toBe(true); };
    expect(await run({ onVersion })).toMatchObject({ cancelled: true, pid: null });
    expect(await records()).toEqual([]);
  }, 30_000);

  it.each(["preparation", "authorization", "preparation error"] as const)("preserves live cancellation across recovery during %s", async (phase) => {
    const owner = { id: defaults.runId, hostname: hostname(), copilotSessionId: defaults.sessionId, executionPath: defaults.repoPath };
    await prepareCaseIqRunLaunch(owner, async (folder) => { await mkdir(folder, { recursive: true }); });
    const cancelAndRecover = async () => {
      expect(await cancelRun(defaults.runId)).toBe(true);
      expect(await inspectInterruptedCaseIqRun(owner)).toMatchObject({ stopped: true, cancelled: true });
    };
    const onSpawn = vi.fn();
    const authorizeLaunch = async () => {
      const outcome = await authorizeCaseIqRunLaunch(owner);
      if (phase === "authorization") await cancelAndRecover();
      return outcome;
    };
    const onVersion = async () => {
      if (phase !== "authorization") await cancelAndRecover();
      if (phase === "preparation error") throw new Error("Synthetic concurrent preparation failure.");
    };
    expect(await run({
      onSpawn, onVersion, authorizeLaunch,
      persistPrelaunchCancellation: (attempt) => persistCaseIqPrelaunchCancellation(owner, attempt),
    })).toMatchObject({ cancelled: true, pid: null });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(await records()).toEqual([]);
  }, 30_000);

  it.each([
    ["first launch", "saved"], ["first launch", "write failed"],
    ["model fallback", "saved"], ["model fallback", "write failed"],
  ] as const)("does not settle %s while its cancellation record is being written (%s)", async (phase, outcome) => {
    const retry = phase === "model fallback";
    if (retry) await scenario("model-fallback");
    const owner = { id: defaults.runId, hostname: hostname(), copilotSessionId: defaults.sessionId, executionPath: defaults.repoPath };
    await prepareCaseIqRunLaunch(owner, async (folder) => { await mkdir(folder, { recursive: true }); });
    const preparing = Promise.withResolvers<void>();
    const continuePreparing = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    const publish = Promise.withResolvers<void>();
    const originalLink = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).link;
    vi.mocked(link).mockImplementation(async (source, destination) => {
      if (typeof destination === "string" && path.basename(destination) === (retry ? "cancel-retry.json" : "cancel.json")) {
        writing.resolve();
        await publish.promise;
      }
      return originalLink(source, destination);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSpawn = vi.fn();
    const events: CopilotRunEvent[] = [];
    let versions = 0;
    const pending = run({
      ...(retry ? { model: "missing-model", fallbackModel: "working-model" } : {}),
      onSpawn,
      authorizeLaunch: async () => {
        const authorization = await authorizeCaseIqRunLaunch(owner);
        if (!retry) {
          preparing.resolve();
          await continuePreparing.promise;
        }
        return authorization;
      },
      persistPrelaunchCancellation: (attempt) => persistCaseIqPrelaunchCancellation(owner, attempt),
      onVersion: async () => {
        if (!retry || ++versions !== 2) return;
        preparing.resolve();
        await continuePreparing.promise;
        if (outcome === "write failed") throw new Error("Synthetic concurrent retry preparation error.");
      },
    });
    getRunEmitter(defaults.runId)!.on("event", (event: CopilotRunEvent) => { events.push(event); });
    const observed = pending.catch((error: unknown) => error);
    let cancel: Promise<unknown> | undefined;
    try {
      await Promise.race([preparing.promise, observed.then(() => { throw new Error("Run ended before the launch gate."); })]);
      cancel = cancelRun(defaults.runId).catch((error: unknown) => error);
      await Promise.race([writing.promise, cancel.then(() => { throw new Error("Cancellation returned without writing its record."); })]);
      continuePreparing.resolve();
      expect(await Promise.race([
        observed.then(() => "run finished"),
        new Promise((resolve) => setTimeout(() => resolve("record pending"), 100)),
      ])).toBe("record pending");
      expect(events.filter((event) => event.type === "exit")).toEqual([]);
      expect(onSpawn).toHaveBeenCalledTimes(retry ? 1 : 0);

      if (outcome === "saved") {
        publish.resolve();
        expect(await cancel).toBe(true);
        expect(await observed).toMatchObject({ cancelled: true, timedOut: false });
        expect(await inspectInterruptedCaseIqRun(owner)).toMatchObject({ stopped: true, cancelled: true });
      } else {
        publish.reject(new Error("Synthetic cancellation record write failed."));
        expect(await cancel).toMatchObject({ status: 409 });
        expect(await observed).toBeInstanceOf(CaseIqRunUnconfirmedError);
        expect(events).toContainEqual({ type: "error", message: expect.stringContaining("This Work remains reserved") });
        expect(events.filter((event) => event.type === "exit")).toEqual([]);
        expect(logged).toHaveBeenCalled();
      }
      expect(onSpawn).toHaveBeenCalledTimes(retry ? 1 : 0);
      expect(await records()).toHaveLength(retry ? 1 : 0);
    } finally {
      continuePreparing.resolve();
      publish.resolve();
      await Promise.allSettled([observed, cancel]);
      vi.mocked(link).mockImplementation(originalLink);
      logged.mockRestore();
    }
  }, 45_000);

  it("does not spawn the Windows wrapper when the original launch is sealed", async () => {
    const owner = { id: defaults.runId, hostname: hostname(), copilotSessionId: defaults.sessionId, executionPath: defaults.repoPath };
    await prepareCaseIqRunLaunch(owner, async (folder) => { await mkdir(folder, { recursive: true }); });
    const onVersion = async () => {
      expect(await inspectInterruptedCaseIqRun(owner)).toMatchObject({ stopped: true, beforeLaunch: true });
    };
    const onSpawn = vi.fn();
    await expect(run({ onSpawn, onVersion, authorizeLaunch: () => authorizeCaseIqRunLaunch(owner) }))
      .rejects.toThrow("No Prompt was sent");
    expect(onSpawn).not.toHaveBeenCalled();
    expect(await records()).toEqual([]);
  }, 30_000);

  it("does not authorize native execution when cancellation arrives inside the acceptance checks", async () => {
    mocks.updateRun.mockImplementationOnce(async () => {
      expect(await cancelRun(defaults.runId)).toBe(true);
      return { count: 1 };
    });
    expect(await run()).toMatchObject({ cancelled: true });
    const parent = path.join(state, "requests", defaults.runId);
    const [attempt] = await readdir(parent);
    await expect(readFile(path.join(parent, attempt, "accept.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await records()).toEqual([]);
  }, 30_000);

  it("resumes the same Session across runtime updates and records each Run's own source version", async () => {
    const versions: CaseIqRunVersion[] = [];
    const onVersion = async (version: CaseIqRunVersion) => { versions.push(version); };
    await run({ onVersion });
    const firstRunId = defaults.runId;
    const launcher = `${await readFile(installation.launcherPath, "utf8")}\n# Synthetic updated launcher.\n`;
    await writeFile(installation.launcherPath, launcher);
    installation = { ...installation, sourceCommit: "b".repeat(40),
      launcherSha256: createHash("sha256").update(launcher).digest("hex"),
      nativeVersion: "1.0.107", sourceBranch: "feature/updated", sourceDirty: true };
    vi.mocked(getCaseIqInstallation).mockResolvedValue(installation);
    await writeFile(configuration, JSON.stringify({ record, mode: "complete", nativeVersion: "1.0.107" }));
    const runId = randomUUID();
    expect(await run({ runId, resumeSession: true, prompt: "Synthetic updated-version follow-up", onVersion }))
      .toMatchObject({ exitCode: 0, incomplete: false });
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ sourceCommit: "a".repeat(40), nativeVersion: "1.0.105" });
    expect(versions[1]).toMatchObject({ sourceCommit: "b".repeat(40), sourceBranch: "feature/updated",
      sourceDirty: true, nativeVersion: "1.0.107", launcherSha256: installation.launcherSha256 });
    const native = await records();
    expect(native[1]).toMatchObject({ resumed: true, sessionId: native[0].sessionId, home: native[0].home });
    const firstAttempt = (await readdir(path.join(state, "requests", firstRunId)))[0];
    const previousRequest = JSON.parse(await readFile(path.join(state, "requests", firstRunId, firstAttempt, "request.json"), "utf8"));
    expect(previousRequest.sourceCommit).toBe("a".repeat(40));
    const log = await readFile(getRunLogPath(runId), "utf8");
    expect(log).toContain(`CaseIQ version: ${"b".repeat(40)}`);
    expect(readNativeSessionBindingSync(defaults.sessionId)).toMatchObject({
      sourceCommit: "b".repeat(40), home: native[0].home, nativeVersion: "1.0.107",
    });
  }, 45_000);

  it("freezes approved exact MCP tools for a new Follow Up without changing the original Session or previous Run", async () => {
    await run();
    await mkdir(caseIqToolPermissionsDirectory(), { recursive: true });
    await writeCaseIqToolApprovals(defaults.userId, defaults.workId, defaults.sessionId, ["case_get"]);
    const runId = randomUUID();
    const result = await run({ runId, prompt: "Synthetic scoped tool follow-up", resumeSession: true });
    expect(result).toMatchObject({ exitCode: 0, incomplete: false });
    const native = await records();
    expect(native[0].args).not.toContain("SupportIQ(case_get)");
    expect(native[1].args).toContain("SupportIQ(case_get)");
    expect(native[1]).toMatchObject({ home: native[0].home, sessionId: native[0].sessionId, resumed: true });
    const attempts = await readdir(path.join(state, "requests", runId));
    const request = JSON.parse(await readFile(path.join(state, "requests", runId, attempts[0], "request.json"), "utf8"));
    expect(request.mcpToolApprovals).toEqual([{ serverName: "SupportIQ", approvedTools: ["case_get"], autoApprove: false }]);
  }, 45_000);

  it("freezes explicit SupportIQ-only automatic approval and returns to retained exact rules when disabled", async () => {
    await run();
    await mkdir(caseIqToolPermissionsDirectory(), { recursive: true });
    await writeCaseIqToolApprovals(defaults.userId, defaults.workId, defaults.sessionId, ["case_get"], true);
    const runId = randomUUID();
    expect(await run({ runId, prompt: "Synthetic automatic-mode follow-up", resumeSession: true })).toMatchObject({ exitCode: 0 });
    const attempts = await readdir(path.join(state, "requests", runId));
    const request = JSON.parse(await readFile(path.join(state, "requests", runId, attempts[0], "request.json"), "utf8"));
    expect(request.mcpToolApprovals).toEqual([{ serverName: "SupportIQ", approvedTools: ["case_get"], autoApprove: true }]);
    expect(request.disableNativeAutoUpdate).toBe(true);
    await writeCaseIqToolApprovals(defaults.userId, defaults.workId, defaults.sessionId, ["case_get"], false);
    expect(await run({ runId: randomUUID(), prompt: "Synthetic exact-mode follow-up", resumeSession: true })).toMatchObject({ exitCode: 0 });
    const native = await records();
    expect(native[1].args).toContain("SupportIQ");
    expect(native[1].args).toContain("--no-auto-update");
    expect(native[1].args).not.toContain("--allow-all-tools");
    expect(native[2].args).toContain("SupportIQ(case_get)");
    expect(native[2].args).not.toContain("SupportIQ");
    expect(native[2]).toMatchObject({ home: native[0].home, sessionId: native[0].sessionId, resumed: true });
  }, 60_000);

  it("freezes independent exact and automatic MCP grants while resuming the original CaseIQ session", async () => {
    await run();
    await mkdir(caseIqToolPermissionsDirectory(), { recursive: true });
    await writeCaseIqMcpApprovals(defaults.userId, defaults.workId, defaults.sessionId, [
      { serverName: "SupportIQ", approvedTools: ["case_get"], autoApprove: false },
      { serverName: "safewright", approvedTools: ["browser_snapshot"], autoApprove: true },
    ]);
    const runId = randomUUID();
    expect(await run({ runId, prompt: "Synthetic per-MCP follow-up", resumeSession: true })).toMatchObject({ exitCode: 0 });
    const native = await records();
    expect(native[1].args).toContain("SupportIQ(case_get)");
    expect(native[1].args).toContain("safewright");
    expect(native[1].args).not.toContain("SupportIQ");
    expect(native[1].args).not.toContain("--allow-all-tools");
    expect(native[1]).toMatchObject({ home: native[0].home, sessionId: native[0].sessionId, resumed: true });
    const attempts = await readdir(path.join(state, "requests", runId));
    const request = JSON.parse(await readFile(path.join(state, "requests", runId, attempts[0], "request.json"), "utf8"));
    expect(request.mcpToolApprovals.map((server: { serverName: string }) => server.serverName)).toEqual(["SupportIQ", "safewright"]);
    expect(request).not.toHaveProperty("autoApproveSupportIq");
    expect(request).not.toHaveProperty("approvedMcpTools");
  }, 45_000);

  it("initializes a new session from Settings once and retains that snapshot after Settings changes", async () => {
    mocks.initialConfiguration.mockResolvedValue({
      origin: "settings", defaults: { defaultAutoApprove: true, servers: [
        { serverName: "SupportIQ", autoApprove: true }, { serverName: "safewright", autoApprove: true },
      ] }, servers: [],
    });
    expect(await run()).toMatchObject({ exitCode: 0 });
    mocks.initialConfiguration.mockResolvedValue({
      origin: "settings", defaults: { defaultAutoApprove: false, servers: [] }, servers: [],
    });
    expect(await run({ runId: randomUUID(), prompt: "Synthetic inherited defaults follow-up", resumeSession: true })).toMatchObject({ exitCode: 0 });
    const native = await records();
    expect(native[0].args).toContain("SupportIQ");
    expect(native[0].args).toContain("safewright");
    expect(native[1].args).toContain("SupportIQ");
    expect(native[1].args).toContain("safewright");
    expect(mocks.initialConfiguration).toHaveBeenCalledOnce();
  }, 45_000);

  it("follows the original launcher's exact session-directory rename before reading history and Follow Up", async () => {
    await scenario("rename-after-run");
    expect(await run()).toMatchObject({ exitCode: 0, incomplete: false, finalOutput: `Synthetic CaseIQ response: ${defaults.prompt}` });
    const binding = readNativeSessionBindingSync(defaults.sessionId)!;
    expect(binding.finalHome).toBe(path.join(path.dirname(binding.home!), defaults.sessionId));
    const second = await run({ runId: randomUUID(), prompt: "Follow up after rename", resumeSession: true });
    expect(second).toMatchObject({ exitCode: 0, incomplete: false });
    const native = await records();
    expect(native[1]).toMatchObject({ resumed: true, sessionId: native[0].sessionId, home: binding.finalHome });
    expect(readNativeSessionBindingSync(defaults.sessionId)).toMatchObject({ home: binding.home, finalHome: binding.finalHome });
  }, 45_000);

  it("preserves renamed history after a graceful cancellation without substituting another session", async () => {
    await scenario("rename-wait");
    const pending = run();
    await waitForNative(pending);
    const [native] = await records();
    await cancelRun(defaults.runId);
    expect(await pending).toMatchObject({ cancelled: true });
    const binding = readNativeSessionBindingSync(defaults.sessionId)!;
    expect(binding).toMatchObject({ home: native.home, finalHome: path.join(path.dirname(native.home), defaults.sessionId) });
    expect(processIsAlive(native.pid)).toBe(false);
  }, 30_000);

  it("cancels the owned background process through the normal web cancellation registry", async () => {
    await scenario("wait");
    const wrapperSpawn = vi.fn(() => {
      expect(getCaseIqStartup(defaults.runId)?.phase).toBe("launcher");
    });
    const pending = run({ onSpawn: wrapperSpawn });
    expect(getCaseIqStartup(defaults.runId)?.phase).toBe("checking");
    await waitForNative(pending);
    await vi.waitFor(() => expect(getCaseIqStartup(defaults.runId)?.phase).toBe("processing"), { timeout: 5000 });
    expect(getCaseIqStartup(defaults.runId)?.steps.map((step) => step.phase)).toEqual([
      "checking", "session", "launcher", "accepted", "native", "processing",
    ]);
    expect(wrapperSpawn).toHaveBeenCalledOnce();
    const [native] = await records();
    expect(isNativeCopilotRunActive(defaults.runId)).toBe(true);
    const cancelling = cancelRun(defaults.runId);
    expect(getCaseIqStartup(defaults.runId)?.phase).toBe("stopping");
    expect(await cancelling).toBe(true);
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false });
    expect(processIsAlive(native.pid)).toBe(false);
    expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
    expect(getCaseIqStartup(defaults.runId)).toBeNull();
  }, 30_000);

  it("does not cancel a completed Run while its session result is being collected", async () => {
    const insights = await vi.importActual<typeof import("./copilot-session-insights")>("./copilot-session-insights");
    const collecting = Promise.withResolvers<void>();
    const resumeCollection = Promise.withResolvers<void>();
    vi.mocked(readCopilotSessionInsights).mockImplementationOnce(async (...args) => {
      collecting.resolve();
      await resumeCollection.promise;
      return insights.readCopilotSessionInsights(...args);
    });
    const pending = run();
    try {
      await Promise.race([collecting.promise, pending.then(() => { throw new Error("CaseIQ did not reach result collection."); })]);
      await expect(cancelRun(defaults.runId)).rejects.toMatchObject({
        status: 409, message: expect.stringContaining("already reported exit"),
      });
      resumeCollection.resolve();
      await expect(pending).resolves.toMatchObject({
        exitCode: 0, cancelled: false, timedOut: false, finalOutput: `Synthetic CaseIQ response: ${defaults.prompt}`,
      });
      expect(stopCopilotProcess).not.toHaveBeenCalled();
    } finally {
      resumeCollection.resolve();
      await Promise.allSettled([pending]);
    }
  }, 30_000);

  it("bounds cancellation and hands off a wrapper that never reports close", async () => {
    const child = syntheticWrapper();
    vi.mocked(spawn).mockReturnValueOnce(child);
    vi.mocked(stopCopilotProcess).mockResolvedValueOnce(undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const spawned = Promise.withResolvers<void>();
    const releaseRunner = Promise.withResolvers<void>();
    const pending = run({
      onSpawn: () => { spawned.resolve(); return releaseRunner.promise; },
    });
    try {
      await Promise.race([spawned.promise, pending.then(() => { throw new Error("CaseIQ did not reach wrapper startup."); })]);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let replied = false;
      const cancellation = cancelRun(defaults.runId).catch((error: unknown) => error).finally(() => { replied = true; });
      const concurrent = cancelRun(defaults.runId).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(stopCopilotProcess).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stopCopilotProcess).toHaveBeenCalledExactlyOnceWith(child);
      await vi.advanceTimersByTimeAsync(16_999);
      expect(replied).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await cancellation).toBeInstanceOf(CaseIqRunUnconfirmedError);
      expect(await concurrent).toBeInstanceOf(CaseIqRunUnconfirmedError);

      vi.useRealTimers();
      releaseRunner.resolve();
      await expect(pending).rejects.toBeInstanceOf(CaseIqRunUnconfirmedError);
      expect(stopCopilotProcess).toHaveBeenCalledOnce();
      expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
      expect(getCaseIqStartup(defaults.runId)).toBeNull();
      expect(child.stdout.listenerCount("data")).toBe(0);
      const parent = path.join(state, "requests", defaults.runId);
      const [attempt] = await readdir(parent);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(path.join(parent, attempt, "cancel.json"), "utf8"))).toMatchObject({ reason: "user" });
      });
    } finally {
      vi.useRealTimers();
      child.emit("close", null);
      releaseRunner.resolve();
      await Promise.allSettled([pending]);
      errorLog.mockRestore();
    }
  }, 30_000);

  it.each([false, true])("rejects cancellation after a wrapper closes without exit receipts (already closed: %s)", async (alreadyClosed) => {
    const child = syntheticWrapper();
    vi.mocked(spawn).mockReturnValueOnce(child);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const accepted = Promise.withResolvers<string>();
    const releaseRunner = Promise.withResolvers<void>();
    const pending = run({
      onSpawn: async () => {
        const runDirectory = path.join(state, "requests", defaults.runId);
        const [attempt] = await readdir(runDirectory);
        const directory = path.join(runDirectory, attempt);
        const request = parseNativeBridgeRequest(JSON.parse(await readFile(path.join(directory, "request.json"), "utf8")));
        await writeFile(path.join(directory, "accept.json"), JSON.stringify({
          ...bridgeCorrelation(request), action: "accept", preparedHash: "a".repeat(64),
        }));
        accepted.resolve(directory);
        await releaseRunner.promise;
      },
    });
    try {
      const directory = await Promise.race([accepted.promise, pending.then(() => { throw new Error("CaseIQ did not reach wrapper startup."); })]);
      if (alreadyClosed) child.emit("close", 1, null);
      const cancellation = cancelRun(defaults.runId);
      if (!alreadyClosed) child.emit("close", 1, null);
      await expect(cancellation).rejects.toBeInstanceOf(CaseIqRunUnconfirmedError);
      releaseRunner.resolve();
      await expect(pending).rejects.toBeInstanceOf(CaseIqRunUnconfirmedError);
      expect(stopCopilotProcess).not.toHaveBeenCalled();
      expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
      if (!alreadyClosed) {
        await vi.waitFor(async () => {
          expect(JSON.parse(await readFile(path.join(directory, "cancel.json"), "utf8"))).toMatchObject({ reason: "user" });
        });
      }
    } finally {
      child.emit("close", 1, null);
      releaseRunner.resolve();
      await Promise.allSettled([pending]);
      errorLog.mockRestore();
    }
  }, 30_000);

  it("can cancel during preparation without launching a native process or releasing another Run", async () => {
    const pending = run();
    expect(getCaseIqStartup(defaults.runId)?.phase).toBe("checking");
    expect(await cancelRun(defaults.runId)).toBe(true);
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false, pid: null });
    expect(await records()).toEqual([]);
    expect(getCaseIqInstallation).not.toHaveBeenCalled();
    expect(isNativeCopilotRunActive(defaults.runId)).toBe(false);
    expect(getCaseIqStartup(defaults.runId)).toBeNull();
  });

  it("applies one timeout to preparation and native execution without opening a terminal", async () => {
    await scenario("wait");
    const result = await run({ timeoutSeconds: 7 });
    expect(result).toMatchObject({ timedOut: true, cancelled: false });
    for (const native of await records()) expect(processIsAlive(native.pid)).toBe(false);
  }, 30_000);

  it("does not report a timeout when the wrapper exited before the deadline was observed", async () => {
    const child = syntheticWrapper();
    vi.mocked(spawn).mockReturnValueOnce(child);
    const readClock = Date.now;
    let advance = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => readClock() + advance);
    try {
      await expect(run({
        timeoutSeconds: 30,
        onSpawn: async () => {
          child.emit("close", 1, null);
          advance = 31_000;
        },
      })).rejects.toThrow("CaseIQ exited without a confirmed native result");
      expect(stopCopilotProcess).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  it("does not turn a live timeout into user cancellation once the stop has started", async () => {
    const child = syntheticWrapper();
    vi.mocked(spawn).mockReturnValueOnce(child);
    const spawned = Promise.withResolvers<string>();
    const continueRun = Promise.withResolvers<void>();
    const pending = run({
      timeoutSeconds: 30,
      onSpawn: async () => {
        const requestRoot = path.join(state, "requests", defaults.runId);
        const [attempt] = await readdir(requestRoot);
        spawned.resolve(path.join(requestRoot, attempt));
        await continueRun.promise;
      },
    });
    try {
      const directory = await Promise.race([spawned.promise, pending.then(() => { throw new Error("CaseIQ did not reach wrapper startup."); })]);
      const readClock = Date.now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => readClock() + 31_000);
      try {
        continueRun.resolve();
        await vi.waitFor(async () => {
          expect(JSON.parse(await readFile(path.join(directory, "cancel.json"), "utf8"))).toMatchObject({ reason: "timeout" });
        });
        await expect(cancelRun(defaults.runId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("different stop request") });
        child.emit("close", null);
        await expect(pending).resolves.toMatchObject({ cancelled: false, timedOut: true });
      } finally {
        clock.mockRestore();
      }
    } finally {
      continueRun.resolve();
      child.emit("close", null);
      await Promise.allSettled([pending]);
    }
  }, 30_000);

  it("automatically continues unfinished work through CaseIQ rather than ordinary CLI", async () => {
    await scenario("incomplete-once");
    const events: CopilotRunEvent[] = [];
    const pending = run({ maxIncompleteContinuations: 1 });
    getRunEmitter(defaults.runId)!.on("event", (event: CopilotRunEvent) => { events.push(event); });
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 0, incomplete: false, continuationCount: 1 });
    const native = await records();
    expect(native).toHaveLength(2);
    expect(native[1]).toMatchObject({ prompt: INCOMPLETE_SESSION_PROMPT, resumed: true, home: native[0].home });
    expect(events).toContainEqual({ type: "line", data: expect.stringContaining("session (1/1)") });
  }, 45_000);

  it.each(["incomplete-once", "model-fallback"] as const)("preserves cancellation before the retry wrapper starts (%s)", async (mode) => {
    await scenario(mode);
    const owner = { id: defaults.runId, hostname: hostname(), copilotSessionId: defaults.sessionId, executionPath: defaults.repoPath };
    const attemptRoot = path.join(state, "requests", defaults.runId);
    const originalRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
    let stagedAttempts = 0;
    let firstAttempt: string | undefined;
    const onSpawn = vi.fn();
    const observed = vi.fn();
    const checkRecoveredCancellation = async () => {
      const visibleAttempts = await readdir(attemptRoot);
      const acknowledged = await cancelRun(defaults.runId);
      observed({ visibleAttempts, acknowledged, recovery: await inspectInterruptedCaseIqRun(owner) });
    };
    if (mode === "incomplete-once") {
      vi.mocked(rename).mockImplementation(async (source, destination) => {
        if (typeof source === "string" && path.basename(path.dirname(source)) === "request-staging" && ++stagedAttempts === 2) {
          await checkRecoveredCancellation();
        }
        await originalRename(source, destination);
      });
    }
    try {
      const result = await run({
        ...(mode === "model-fallback"
          ? { model: "missing-model", fallbackModel: "working-model" }
          : { maxIncompleteContinuations: 1 }),
        onSpawn,
        onVersion: async ({ attemptId }) => {
          if (!firstAttempt) firstAttempt = attemptId;
          else if (mode === "model-fallback") await checkRecoveredCancellation();
        },
      });
      if (!firstAttempt) throw new Error("CaseIQ did not publish the initial attempt.");
      expect(observed).toHaveBeenCalledExactlyOnceWith({
        visibleAttempts: mode === "incomplete-once" ? [firstAttempt] : expect.arrayContaining([firstAttempt, expect.any(String)]),
        acknowledged: true,
        recovery: expect.objectContaining({ stopped: true, cancelled: true }),
      });
      expect(result).toMatchObject({ cancelled: true, timedOut: false });
      expect(onSpawn).toHaveBeenCalledOnce();
      expect(await records()).toHaveLength(1);
      expect(await inspectInterruptedCaseIqRun(owner)).toMatchObject({ stopped: true, cancelled: true });
      const nativeResult = JSON.parse(await readFile(path.join(attemptRoot, firstAttempt, "native-result.json"), "utf8"));
      expect(nativeResult).toMatchObject({ cancelled: false, exitCode: mode === "model-fallback" ? 1 : 0 });
    } finally {
      vi.mocked(rename).mockImplementation(originalRename);
    }
  }, 45_000);

  it("reports unfinished work after the actual continuation budget instead of claiming completion", async () => {
    await scenario("incomplete");
    const result = await run({ maxIncompleteContinuations: 1 });
    expect(result).toMatchObject({
      exitCode: 0, incomplete: true, continuationCount: 1,
      incompleteReason: expect.stringContaining("tool calls are unfinished"),
    });
    const native = await records();
    expect(native).toHaveLength(2);
    expect(native[1]).toMatchObject({ resumed: true, sessionId: native[0].sessionId, home: native[0].home });
  }, 45_000);

  it("keeps a model fallback in the same CaseIQ provider", async () => {
    await scenario("model-fallback");
    const attempts: { attempt: number; phases: string[] }[] = [];
    const result = await run({ model: "missing-model", fallbackModel: "working-model", onSpawn: () => {
      const startup = getCaseIqStartup(defaults.runId)!;
      attempts.push({ attempt: startup.attempt, phases: startup.steps.map((step) => step.phase) });
    } });
    expect(attempts).toEqual([
      { attempt: 1, phases: ["checking", "session", "launcher"] },
      { attempt: 2, phases: ["checking", "session", "launcher"] },
    ]);
    expect(getCaseIqStartup(defaults.runId)).toBeNull();
    expect(result).toMatchObject({ exitCode: 0, model: "working-model", incomplete: false });
    const native = await records();
    expect(native).toHaveLength(2);
    expect(native.map((item) => item.prompt)).toEqual([defaults.prompt, defaults.prompt]);
    expect(native[0].home).toBe(native[1].home);
  }, 45_000);

  it("rejects a changed installation location before resuming and never substitutes the global home", async () => {
    await run();
    vi.mocked(getCaseIqInstallation).mockResolvedValue({ ...installation, launcherPath: path.join(root, "unrelated", "caseiq.ps1") });
    await expect(run({ runId: randomUUID(), resumeSession: true })).rejects.toThrow("installation location");
    expect(await records()).toHaveLength(1);
  }, 45_000);

  it("preserves a native nonzero exit even when a final message exists", async () => {
    await scenario("exit-7");
    expect(await run()).toMatchObject({ exitCode: 7, incomplete: false });
  }, 30_000);
});
