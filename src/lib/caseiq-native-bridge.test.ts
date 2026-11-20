import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_BRIDGE_FILE_BYTES, NATIVE_BRIDGE_PROTOCOL, bridgeCorrelation, launcherResultSchema,
  nativeBridgeFrameSchema, nativeBridgeRequestSchema, parseNativeBridgeRequest,
} from "../../scripts/native-bridge-protocol.mjs";
import { validateRequestFile } from "../../scripts/caseiq-native-delegate.mjs";
import { stopOwnedProcess } from "../../scripts/owned-process.mjs";
import { buildCopilotEnvironment } from "./copilot-runner";
import { windowsProcessMatchesStartTime } from "./copilot-process";

type Request = z.infer<typeof nativeBridgeRequestSchema>;
type Frame = z.infer<typeof nativeBridgeFrameSchema>;
interface Execution {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  request: Request;
}

let root: string;
let launcher: string;
let directory: string;
let work: string;
let home: string;
let pack: string;
let recordFile: string;
let finishedFile: string;
let enteredFile: string;
let executions: Execution[];
let siblings: ChildProcessWithoutNullStreams[];

async function optionalText(file: string) {
  try { return await readFile(file, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function frames(): Promise<Frame[]> {
  const content = await optionalText(path.join(directory, "journal.jsonl")) ?? "";
  const complete = content.slice(0, content.lastIndexOf("\n") + 1);
  return complete.split("\n").filter(Boolean).map((line) => nativeBridgeFrameSchema.parse(JSON.parse(line)));
}

async function atomicJson(name: string, value: unknown) {
  const file = path.join(directory, name);
  await writeFile(`${file}.tmp`, JSON.stringify(value), { flag: "wx" });
  await rename(`${file}.tmp`, file);
}

async function waitFor(check: () => Promise<boolean>, message: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  executions = [];
  siblings = [];
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-bridge-"));
  directory = path.join(root, "private request");
  launcher = path.join(root, "synthetic launcher.ps1");
  work = path.join(root, "work area");
  home = path.join(root, "session home");
  pack = path.join(root, "synthetic pack");
  recordFile = path.join(root, "native-record.json");
  finishedFile = path.join(root, "launcher-finished.txt");
  enteredFile = path.join(root, "launcher-entered.txt");
  await Promise.all([mkdir(directory), mkdir(work), mkdir(pack)]);
  await copyFile(path.join(process.cwd(), "src", "lib", "__fixtures__", "caseiq-launcher.ps1"), launcher);
});

afterEach(async () => {
  for (const execution of executions) {
    await stopOwnedProcess(execution.child);
    await execution.done;
  }
  for (const child of siblings) await stopOwnedProcess(child);
  if (root) await rm(root, { recursive: true, force: true });
});

async function start(options: {
  launcherMode?: string; nativeMode?: string; accept?: boolean;
  overrides?: Partial<Request>; acceptanceNonce?: string;
} = {}): Promise<Execution> {
  const request = parseNativeBridgeRequest({
    protocolVersion: NATIVE_BRIDGE_PROTOCOL,
    requestId: randomUUID(), runId: randomUUID(), attemptId: randomUUID(), nonce: randomUUID(),
    launcherPath: launcher, launcherSha256: createHash("sha256").update(await readFile(launcher)).digest("hex"),
    nativeExecutable: process.execPath, nativeVersion: "1.0.105",
    workingDirectory: work, sessionId: randomUUID(), prompt: "Synthetic request",
    packs: ["synthetic-pack"],
    testExecutableArgs: [path.join(process.cwd(), "src", "lib", "__fixtures__", "caseiq-native.mjs")],
    ...options.overrides,
  });
  const file = path.join(directory, "request.json");
  await writeFile(file, JSON.stringify(request), { flag: "wx", mode: 0o600 });
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(process.cwd(), "scripts", "workboard-caseiq.ps1"),
    "-RequestFile", file, "-NodeExecutable", process.execPath,
  ], {
    cwd: work, windowsHide: true,
    env: {
      ...buildCopilotEnvironment(process.env), NODE_ENV: "test",
      COPILOT_GITHUB_TOKEN: "synthetic-secret-not-for-journals",
      WORKBOARD_BRIDGE_TEST_HOME: home,
      WORKBOARD_BRIDGE_TEST_PACK: pack,
      WORKBOARD_BRIDGE_TEST_RECORD: recordFile,
      WORKBOARD_BRIDGE_TEST_FINISHED: finishedFile,
      WORKBOARD_BRIDGE_TEST_ENTERED: enteredFile,
      WORKBOARD_BRIDGE_TEST_LAUNCHER: options.launcherMode ?? "",
      WORKBOARD_BRIDGE_TEST_NATIVE: options.nativeMode ?? "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const acceptance = options.accept === false ? Promise.resolve() : (async () => {
    while (child.exitCode === null && child.signalCode === null) {
      const prepared = (await frames()).find((event) => event.kind === "prepared");
      if (prepared) {
        await atomicJson("accept.json", {
          ...bridgeCorrelation(request), nonce: options.acceptanceNonce ?? request.nonce,
          action: "accept", preparedHash: prepared.binding.preparedHash,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  const done = (async () => {
    const code = await closed;
    await acceptance;
    return { code, stdout, stderr };
  })();
  const execution = { child, done, request };
  executions.push(execution);
  return execution;
}

async function result() {
  return launcherResultSchema.parse(JSON.parse(
    await readFile(path.join(directory, "launcher-result.json"), "utf8"),
  ));
}

describe("native bridge request validation", () => {
  it("rejects authentication requests that could deliver a task or change session", () => {
    const request = {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL, requestId: randomUUID(), runId: randomUUID(),
      attemptId: randomUUID(), nonce: randomUUID(), launcherPath: path.join(tmpdir(), "caseiq.ps1"),
      launcherSha256: "a".repeat(64), nativeExecutable: process.execPath, nativeVersion: "1.0.105",
      workingDirectory: tmpdir(), sessionId: randomUUID(), mode: "terminal",
      authenticationOnly: true, resume: true, prompt: "", sendPrompt: false,
    };
    expect(parseNativeBridgeRequest(request).authenticationOnly).toBe(true);
    for (const extra of [
      { mode: "prompt" }, { resume: false }, { prompt: "must not run" },
      { sendPrompt: true }, { attachments: [path.join(tmpdir(), "private-evidence.txt")] },
    ]) expect(() => parseNativeBridgeRequest({ ...request, ...extra })).toThrow("Authentication");
  });

  it("rejects unknown configuration and unrestricted executable overrides outside tests", () => {
    const request = {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL,
      requestId: "request", runId: "run", attemptId: "attempt", nonce: randomUUID(),
      launcherPath: path.join(process.cwd(), "synthetic.ps1"), launcherSha256: "a".repeat(64),
      nativeExecutable: process.execPath, nativeVersion: "1.0.105",
      workingDirectory: process.cwd(), sessionId: randomUUID(), prompt: "Synthetic",
    };
    expect(() => parseNativeBridgeRequest({ ...request, command: "untrusted" })).toThrow();
    expect(() => parseNativeBridgeRequest({ ...request, testExecutableArgs: ["fake.mjs"] }, { NODE_ENV: "production" })).toThrow("test-only");
  });
});

describe.skipIf(process.platform !== "win32")("CaseIQ offline native bridge", () => {
  it("does not require an auth-only flag for an ordinary request under StrictMode", async () => {
    const execution = await start({ overrides: { disableNativeAutoUpdate: true } });
    expect(Object.hasOwn(execution.request, "authenticationOnly")).toBe(false);
    const completion = await execution.done;
    expect(completion.code, completion.stderr).toBe(0);
    expect((await frames()).filter((frame) => frame.kind === "native-spawn")).toHaveLength(1);
    expect((await frames()).at(-1)).toMatchObject({ kind: "native-result", exitCode: 0, error: null });
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args).toContain(execution.request.prompt);
    expect(record.args).not.toContain("/mcp auth SupportIQ");
    expect(completion.stdout).not.toContain("ACTION REQUIRED: SUPPORTIQ SIGN-IN ONLY");
  });

  it("preserves legacy omitted boolean flags without rewriting the validated request", async () => {
    const execution = await start();
    expect(Object.hasOwn(execution.request, "authenticationOnly")).toBe(false);
    expect(Object.hasOwn(execution.request, "disableNativeAutoUpdate")).toBe(false);
    const completion = await execution.done;
    expect(completion.code, completion.stderr).toBe(0);
    const validated = JSON.parse(await readFile(path.join(directory, "validated-request.json"), "utf8"));
    expect(Object.hasOwn(validated, "authenticationOnly")).toBe(false);
    expect(Object.hasOwn(validated, "disableNativeAutoUpdate")).toBe(false);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args).not.toContain("--no-auto-update");
    expect(record.args).toContain(execution.request.prompt);
    expect((await frames()).filter((frame) => frame.kind === "native-spawn")).toHaveLength(1);
  });

  it("executes only the accepted scoped tool rules and records them in the actual prepared argument hash", async () => {
    const execution = await start({ overrides: { approvedMcpTools: ["case_get"] } });
    const completion = await execution.done;
    expect(completion.code, completion.stderr).toBe(0);
    const prepared = (await frames()).find((event) => event.kind === "prepared");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args).toContain("SupportIQ(case_get)");
    expect(record.args).not.toContain("--allow-all-tools");
    expect(record.args).not.toContain("--allow-all");
    expect(prepared?.binding.allowTools).toContain("SupportIQ(case_get)");
    expect(prepared?.binding.argumentsHash).toBe(createHash("sha256").update(JSON.stringify(record.args)).digest("hex"));
  });

  it("uses the frozen bundled CLI mode for both version probing and actual native execution", async () => {
    const execution = await start({ overrides: { disableNativeAutoUpdate: true } });
    const completion = await execution.done;
    expect(completion.code, completion.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args.filter((argument: string) => argument === "--no-auto-update")).toHaveLength(1);
    const prepared = (await frames()).find((event) => event.kind === "prepared");
    expect(prepared?.binding.nativeVersion).toBe(execution.request.nativeVersion);
    expect(prepared?.binding.argumentsHash).toBe(createHash("sha256").update(JSON.stringify(record.args)).digest("hex"));
  });

  it("captures the real binding and preserves quoted multiline Unicode, flags, files and exit codes", async () => {
    const attachment = path.join(work, "evidence file.txt");
    await writeFile(attachment, "synthetic attachment");
    const prompt = "Synthetic \"quoted\" $(throw 'must not run') `literal`\n\u4e2d\u6587";
    const execution = await start({
      nativeMode: "exit-17",
      overrides: { prompt, attachments: [attachment], caseNumber: "SYNTHETIC-CASE", model: "synthetic-model" },
    });
    const completion = await execution.done;
    expect(completion.code, completion.stderr).toBe(17);
    expect(completion.stdout).toContain("Synthetic launcher log");
    const events = await frames();
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    const prepared = events.find((event) => event.kind === "prepared");
    expect(prepared?.binding).toMatchObject({
      home, sessionId: execution.request.sessionId, launchId: "synthetic-launch",
      caseNumber: "SYNTHETIC-CASE", workingDirectory: work,
      pluginDirectories: [pack], instructionDirectories: [pack],
      model: "synthetic-model", modelSource: "caller",
    });
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args).toEqual(expect.arrayContaining([
      "-p", prompt, "--attachment", attachment, `--session-id=${execution.request.sessionId}`,
      "--output-format", "json", "--stream", "on", "--model", "synthetic-model",
    ]));
    expect(record.args).not.toContain("--allow-all-tools");
    expect(record.args).not.toContain("--allow-all");
    expect(record.home).toBe(home);
    expect(await result()).toMatchObject({ bridgeExitCode: 17, nativeExitCode: 17, scriptError: false });
    expect(await optionalText(finishedFile)).toBe("finished");
    expect(JSON.stringify(events)).not.toContain("synthetic-secret-not-for-journals");
  }, 30_000);

  it("resumes only the exact requested session and new prompt", async () => {
    const execution = await start({ overrides: { resume: true, prompt: "Only this new follow-up" } });
    expect((await execution.done).code).toBe(0);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args).toContain(`--resume=${execution.request.sessionId}`);
    expect(record.args.some((arg: string) => arg.startsWith("--session-id"))).toBe(false);
    expect(record.args).toContain("Only this new follow-up");
    expect((await frames()).filter((event) => event.kind === "native-result")).toHaveLength(1);
    expect(await result()).not.toHaveProperty("taskComplete");
  }, 30_000);

  it("opens Terminal without sending a Prompt and records the actual wrapper exit", async () => {
    const launchFile = path.join(root, "terminal-launch.json");
    await writeFile(launchFile, "{}");
    const execution = await start({ overrides: {
      mode: "terminal", sendPrompt: false, prompt: "", terminalLaunchFile: launchFile,
    } });
    const completion = await execution.done;
    expect(completion.code, completion.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args).not.toContain("-p");
    expect(record.args).not.toContain("-i");
    expect(record.args).not.toContain("--output-format");
    expect((await frames()).filter((event) => event.kind === "native-output")).toHaveLength(0);
    expect(JSON.parse(await readFile(launchFile, "utf8"))).toMatchObject({
      wrapperPid: expect.any(Number), wrapperStartTime: expect.stringMatching(/^[1-9]\d{0,18}$/), exitCode: 0,
    });
  }, 30_000);

  it("records the creation identity of the actual live Terminal wrapper", async () => {
    const launchFile = path.join(root, "terminal-launch.json");
    await writeFile(launchFile, "{}");
    const execution = await start({ nativeMode: "hang", overrides: {
      mode: "terminal", sendPrompt: false, prompt: "", terminalLaunchFile: launchFile,
    } });
    await waitFor(async () => await optionalText(recordFile) !== null, "Native fixture did not start");
    const metadata = JSON.parse(await readFile(launchFile, "utf8"));
    expect(metadata.wrapperPid).toBe(execution.child.pid);
    await expect(windowsProcessMatchesStartTime(metadata.wrapperPid, metadata.wrapperStartTime)).resolves.toBe(true);
    await atomicJson("cancel.json", { ...bridgeCorrelation(execution.request), action: "cancel", reason: "user" });
    expect((await execution.done).code).toBe(130);
    expect((await frames()).at(-1)).toMatchObject({ cancelled: true });
  }, 30_000);

  it("sends an explicitly selected Terminal Prompt with -i, not batch or broad permissions", async () => {
    const execution = await start({ overrides: { mode: "terminal", sendPrompt: true, prompt: "New interactive \u4e2d\u6587\nrequest" } });
    const completion = await execution.done;
    expect(completion.code, completion.stderr).toBe(0);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args).toEqual(expect.arrayContaining(["-i", execution.request.prompt]));
    expect(record.args).not.toContain("-p");
    expect(record.args).not.toContain("--allow-all-tools");
  }, 30_000);

  it("retains Terminal finalization errors without piping away the interactive console", async () => {
    const execution = await start({
      launcherMode: "finalize-error", overrides: { mode: "terminal", sendPrompt: false, prompt: "" },
    });
    expect((await execution.done).code).toBe(1);
    expect(await result()).toMatchObject({ scriptError: true, nativeExitCode: 0 });
  }, 30_000);

  it("does not execute without an acknowledgement", async () => {
    const execution = await start({ accept: false, overrides: { handshakeTimeoutMs: 100 } });
    expect((await execution.done).code).toBe(1);
    expect(await optionalText(recordFile)).toBeNull();
    const event = (await frames()).find((frame) => frame.kind === "native-result");
    expect(event).toMatchObject({ error: { kind: "handshake-timeout" }, pid: null });
  }, 30_000);

  it("rejects a stale acknowledgement rather than sending the prompt", async () => {
    const execution = await start({ acceptanceNonce: randomUUID() });
    expect((await execution.done).code).toBe(1);
    expect(await optionalText(recordFile)).toBeNull();
    expect((await frames()).at(-1)).toMatchObject({ error: { kind: "protocol-error" }, pid: null });
  }, 30_000);

  it.each(["allow-all", "wrong-session", "unknown-option", "change-launcher"])("rejects a changed %s invocation before the native process starts", async (launcherMode) => {
    const execution = await start({ launcherMode });
    expect((await execution.done).code).toBe(1);
    expect(await optionalText(recordFile)).toBeNull();
    expect(await result()).toMatchObject({ bridgeExitCode: 1, nativeExecutionObserved: false });
  }, 30_000);

  it("does not mistake a flag-like prompt for a permission flag", async () => {
    const execution = await start({ overrides: { prompt: "--allow-all-tools" } });
    expect((await execution.done).code).toBe(0);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    expect(record.args[record.args.indexOf("-p") + 1]).toBe("--allow-all-tools");
  }, 30_000);

  it("fails explicitly when the journal cannot be created", async () => {
    await mkdir(path.join(directory, "journal.jsonl"));
    const execution = await start({ accept: false });
    const completion = await execution.done;
    expect(completion.code).toBe(1);
    expect(completion.stderr).toContain("[CaseIQ bridge]");
    expect(await optionalText(recordFile)).toBeNull();
    expect(await result()).toMatchObject({
      bridgeExitCode: 1, errorKind: "native-result-missing", nativeExecutionObserved: null,
    });
  }, 30_000);

  it("rejects replay of a claimed attempt", async () => {
    const execution = await start();
    expect((await execution.done).code).toBe(0);
    await expect(validateRequestFile(path.join(directory, "request.json"))).rejects.toMatchObject({ code: "EEXIST" });
  }, 30_000);

  it("enforces the exact private input byte limit", async () => {
    const input = {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL,
      requestId: "request", runId: "run", attemptId: "attempt", nonce: randomUUID(),
      launcherPath: launcher, launcherSha256: createHash("sha256").update(await readFile(launcher)).digest("hex"),
      nativeExecutable: process.execPath, nativeVersion: "1.0.105",
      workingDirectory: work, sessionId: randomUUID(), prompt: "Synthetic",
    };
    const json = JSON.stringify(input);
    const file = path.join(directory, "request.json");
    const padding = MAX_BRIDGE_FILE_BYTES - Buffer.byteLength(json);
    await writeFile(file, `${json}${" ".repeat(padding + 1)}`);
    await expect(validateRequestFile(file)).rejects.toMatchObject({ kind: "protocol-error" });
    expect(await optionalText(path.join(directory, "bridge.claim"))).toBeNull();
    await writeFile(file, `${json}${" ".repeat(padding)}`);
    await expect(validateRequestFile(file)).resolves.toBeUndefined();
  });

  it.each(["prepare-throw", "prepare-error", "no-execution"])("does not report %s as a successful task", async (launcherMode) => {
    const execution = await start({ launcherMode });
    expect((await execution.done).code).toBe(1);
    expect(await optionalText(recordFile)).toBeNull();
    expect(await result()).toMatchObject({ bridgeExitCode: 1 });
  }, 30_000);

  it("does not hide non-terminating launcher finalization errors behind native exit zero", async () => {
    const execution = await start({ launcherMode: "finalize-error" });
    expect((await execution.done).code).toBe(1);
    expect(await result()).toMatchObject({ nativeExitCode: 0, scriptError: true, errorKind: "launcher-script-error" });
  }, 30_000);

  it("rejects a repeated invocation instead of replaying the input", async () => {
    const execution = await start({ launcherMode: "repeat" });
    expect((await execution.done).code).toBe(1);
    expect((await frames()).filter((event) => event.kind === "native-spawn")).toHaveLength(1);
  }, 30_000);

  it("retains UTF-8 bytes split by the native process and closes unused stdin", async () => {
    const execution = await start({ nativeMode: "unicode" });
    expect((await execution.done).code).toBe(0);
    const output = (await frames()).filter((event) => event.kind === "native-output")
      .map((event) => event.data).join("");
    expect(output).toContain("Synthetic \u4e2d\u6587");
    expect(output).not.toContain("\uFFFD");
  }, 30_000);

  it("closes the native stdin instead of waiting for input", async () => {
    const execution = await start({ nativeMode: "stdin" });
    expect((await execution.done).code).toBe(0);
    expect((await frames()).some((event) => event.kind === "native-output" && event.data.includes("stdin closed"))).toBe(true);
  }, 30_000);

  it("never promotes native output to a host control frame", async () => {
    const execution = await start({ nativeMode: "spoof" });
    expect((await execution.done).code).toBe(0);
    const events = await frames();
    expect(events.filter((event) => event.kind === "prepared")).toHaveLength(1);
    expect(events.some((event) => event.kind === "native-output" && event.data.includes("model-controlled"))).toBe(true);
  }, 30_000);

  it("cancels the owned native tree while preserving launcher finally and a sibling", async () => {
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      windowsHide: true, detached: process.platform !== "win32",
    });
    siblings.push(sibling);
    const execution = await start({ nativeMode: "hang" });
    await waitFor(async () => await optionalText(recordFile) !== null, "Native fixture did not start");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    await atomicJson("cancel.json", { ...bridgeCorrelation(execution.request), action: "cancel", reason: "user" });
    expect((await execution.done).code).toBe(130);
    expect((await frames()).at(-1)).toMatchObject({ cancelled: true, forced: true });
    expect(await optionalText(finishedFile)).toBe("finished");
    expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
    expect(() => process.kill(record.childPid, 0)).toThrow();
  }, 30_000);

  it("times out without requiring an active browser", async () => {
    const execution = await start({ nativeMode: "hang", overrides: { timeoutMs: 3_000 } });
    expect((await execution.done).code).toBe(124);
    expect((await frames()).at(-1)).toMatchObject({ timedOut: true });
    expect(await optionalText(finishedFile)).toBe("finished");
  }, 30_000);

  it("can stop preparing without launching a native task", async () => {
    const execution = await start({ launcherMode: "prepare-hang", accept: false });
    await waitFor(async () => await optionalText(enteredFile) !== null, "Launcher did not enter preparation");
    await stopOwnedProcess(execution.child);
    await execution.done;
    expect(await optionalText(recordFile)).toBeNull();
  }, 30_000);

  it("rejects an unverified native version before sending a task", async () => {
    const execution = await start({ nativeMode: "wrong-version" });
    expect((await execution.done).code).toBe(1);
    expect(await optionalText(recordFile)).toBeNull();
  }, 30_000);
});
