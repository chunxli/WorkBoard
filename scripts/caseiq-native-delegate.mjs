import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSON5 from "json5";
import {
  MAX_BRIDGE_FILE_BYTES, NativeBridgeError, assertBridgeCorrelation, bridgeCorrelation,
  launcherResultSchema, nativeBridgeAcceptanceSchema, nativeBridgeCancellationSchema,
  nativeBridgeFrameSchema, nativeBridgeInvocationSchema, parseNativeBridgeRequest,
  nativeBridgeMcpApprovals, preparedBindingSchema, validatedBridgeRequestSchema,
} from "./native-bridge-protocol.mjs";
import { stopOwnedProcess } from "./owned-process.mjs";
import { nativeMcpPermissionRules } from "./native-mcp-permissions.mjs";
import { connectCaseIqSharedOAuth } from "./native-shared-oauth.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

async function readJson(file) {
  const fileInfo = await stat(file);
  if (!fileInfo.isFile() || fileInfo.size > MAX_BRIDGE_FILE_BYTES) {
    throw new NativeBridgeError("protocol-error", "Bridge input is not a bounded regular file.");
  }
  return JSON.parse(await readFile(file, "utf8"));
}

async function readOptionalJson(file) {
  try { return await readJson(file); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

async function checkedRequest(file) {
  const request = validatedBridgeRequestSchema.parse(await readJson(file));
  parseNativeBridgeRequest(Object.fromEntries(
    Object.entries(request).filter(([key]) => !["requestDirectory", "validatedAt"].includes(key)),
  ));
  if (await realpath(path.dirname(file)) !== request.requestDirectory) {
    throw new NativeBridgeError("protocol-error", "The request directory changed.");
  }
  return request;
}

export async function validateRequestFile(file) {
  const source = await realpath(file);
  const request = parseNativeBridgeRequest(await readJson(source));
  for (const candidate of [request.launcherPath, request.nativeExecutable, ...request.attachments]) {
    if (!(await stat(candidate)).isFile()) {
      throw new NativeBridgeError("setup-required", "A required bridge input is not a file.");
    }
  }
  if (!(await stat(request.workingDirectory)).isDirectory()) {
    throw new NativeBridgeError("setup-required", "The working directory is unavailable.");
  }
  if (sha256(await readFile(request.launcherPath)) !== request.launcherSha256) {
    throw new NativeBridgeError("runtime-incompatible", "The launcher does not match the frozen version.");
  }
  const requestDirectory = await realpath(path.dirname(source));
  const claim = await open(path.join(requestDirectory, "bridge.claim"), "wx", 0o600);
  await claim.close();
  await writeJson(path.join(requestDirectory, "validated-request.json"), {
    ...request, requestDirectory, validatedAt: Date.now(),
  });
}

function nativeOptions(args) {
  const supported = new Set([
    "-p", "-i", "--output-format", "--stream", "--session-id", "--resume", "--attachment",
    "--model", "--agent", "--context", "--effort", "--add-dir", "--allow-tool",
    "--secret-env-vars", "--disable-mcp-server", "--plugin-dir", "--additional-mcp-config", "--name",
  ]);
  const options = new Map();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (/^--allow-all(?:$|-)/.test(name) || name === "--yolo") {
      throw new NativeBridgeError("unsupported-option", "CaseIQ cannot inherit unrestricted CLI permissions.");
    }
    if (name === "--no-auto-update") {
      if (separator >= 0) throw new NativeBridgeError("protocol-error", "Native update disabling is a flag, not a value.");
      options.set(name, [...(options.get(name) ?? []), "true"]);
      continue;
    }
    if (!supported.has(name)) throw new NativeBridgeError("unsupported-option", `Unsupported native option: ${name}`);
    if (separator < 0 && index + 1 >= args.length) {
      throw new NativeBridgeError("protocol-error", `Missing ${name} value.`);
    }
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  return (name) => options.get(name) ?? [];
}

export function applyMcpToolApprovals(request, invocation) {
  const rules = nativeMcpPermissionRules(nativeBridgeMcpApprovals(request));
  if (!rules.length) return invocation;
  if (request.mode !== "prompt" || request.authenticationOnly) {
    throw new NativeBridgeError("unsupported-option", "Tool approvals cannot change an authentication or Terminal invocation.");
  }
  const allowed = nativeOptions(invocation.nativeArguments)("--allow-tool");
  const nativeArguments = [...invocation.nativeArguments];
  for (const rule of rules) {
    if (!allowed.includes(rule)) { nativeArguments.push("--allow-tool", rule); allowed.push(rule); }
  }
  return nativeBridgeInvocationSchema.parse({ ...invocation, nativeArguments });
}

export const applySupportIqToolApprovals = applyMcpToolApprovals;

async function prepareBinding(request, invocation) {
  const args = invocation.nativeArguments;
  if (sha256(await readFile(request.launcherPath)) !== request.launcherSha256 ||
      invocation.observedVersion !== request.nativeVersion) {
    throw new NativeBridgeError("runtime-incompatible", "The runtime changed during preparation.");
  }
  const values = nativeOptions(args);
  const prompts = values(request.mode === "terminal" ? "-i" : "-p");
  const sessions = values(request.resume ? "--resume" : "--session-id");
  if (request.sharedInputDirectory && !values("--add-dir").includes(request.sharedInputDirectory)) {
    throw new NativeBridgeError("protocol-error", "The native invocation omitted the paired Session's shared input directory.");
  }
  const shouldSendPrompt = request.mode === "prompt" || request.sendPrompt;
  if (JSON.stringify(prompts) !== JSON.stringify(shouldSendPrompt ? [request.prompt] : []) ||
      values(request.mode === "terminal" ? "-p" : "-i").length ||
      sessions.length !== 1 || sessions[0] !== request.sessionId ||
      values(request.resume ? "--session-id" : "--resume").length ||
      JSON.stringify(values("--attachment")) !== JSON.stringify(request.attachments) ||
      JSON.stringify(values("--no-auto-update")) !== JSON.stringify(request.disableNativeAutoUpdate ? ["true"] : []) ||
      JSON.stringify(values("--output-format")) !== JSON.stringify(request.mode === "prompt" ? ["json"] : []) ||
      JSON.stringify(values("--stream")) !== JSON.stringify(request.mode === "prompt" ? ["on"] : [])) {
    throw new NativeBridgeError("protocol-error", "The native invocation does not match the frozen request.");
  }
  for (const [field, option] of [
    ["model", "--model"], ["agent", "--agent"], ["contextTier", "--context"], ["reasoningEffort", "--effort"],
  ]) {
    if (values(option).length > 1 || request[field] !== null &&
        JSON.stringify(values(option)) !== JSON.stringify([request[field]])) {
      throw new NativeBridgeError("protocol-error", `The native ${field} differs from the frozen request.`);
    }
  }
  const additionalMcpConfigs = values("--additional-mcp-config").map((value) => {
    if (!value.startsWith("@") || !path.isAbsolute(value.slice(1))) {
      throw new NativeBridgeError("unsupported-option", "Only explicit MCP configuration files are supported.");
    }
    return value.slice(1);
  });
  const workingDirectory = await realpath(invocation.workingDirectory);
  if (workingDirectory !== await realpath(request.workingDirectory) ||
      invocation.caseNumber !== request.caseNumber) {
    throw new NativeBridgeError("protocol-error", "The launcher selected a different working directory or case.");
  }
  const binding = {
    home: await realpath(invocation.home),
    launchId: invocation.launchId,
    caseNumber: invocation.caseNumber,
    workingDirectory,
    sessionId: request.sessionId,
    resume: request.resume,
    nativeVersion: invocation.observedVersion,
    launcherSha256: request.launcherSha256,
    pluginDirectories: values("--plugin-dir"),
    additionalMcpConfigs,
    instructionDirectories: invocation.instructionDirectories,
    allowTools: values("--allow-tool"),
    model: values("--model")[0] ?? null,
    modelSource: request.model !== null ? "caller" : values("--model").length ? "launcher-default" : "native-default",
    argumentsHash: sha256(JSON.stringify(args)),
  };
  if (request.sharedOAuth) {
    // The original launcher repairs its OAuth link on every launch; reconnect at the final CLI boundary.
    binding.oauthStorage = await connectCaseIqSharedOAuth(request.sharedOAuth, binding);
    if (binding.oauthStorage.mode === "session") {
      console.error(`[CaseIQ bridge] Shared OAuth unavailable (${binding.oauthStorage.reason}). The original Session cache is preserved; use Sign in to SupportIQ for this Session.`);
    }
  }
  return preparedBindingSchema.parse({ ...binding, preparedHash: sha256(JSON.stringify(binding)) });
}

async function createJournal(request) {
  const file = await open(path.join(request.requestDirectory, "journal.jsonl"), "ax", 0o600);
  let sequence = 0;
  let pending = Promise.resolve();
  return {
    append(kind, data) {
      const event = nativeBridgeFrameSchema.parse({
        ...bridgeCorrelation(request), sequence: ++sequence,
        timestamp: new Date().toISOString(), kind, ...data,
      });
      pending = pending.then(async () => {
        await file.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await file.sync();
      });
      return pending.then(() => event);
    },
    async close() {
      try { await pending; } finally { await file.close(); }
    },
  };
}

async function cancellation(request) {
  const value = await readOptionalJson(path.join(request.requestDirectory, "cancel.json"));
  if (value === null) return null;
  const control = nativeBridgeCancellationSchema.parse(value);
  assertBridgeCorrelation(control, request);
  return control;
}

function timedOut(request) {
  return request.timeoutMs !== null && Date.now() - request.validatedAt >= request.timeoutMs;
}

async function waitForAcceptance(request, binding) {
  const deadline = Date.now() + request.handshakeTimeoutMs;
  while (true) {
    const cancelled = await cancellation(request);
    if (cancelled || timedOut(request)) return cancelled?.reason ?? "timeout";
    const value = await readOptionalJson(path.join(request.requestDirectory, "accept.json"));
    if (value !== null) {
      const acceptance = nativeBridgeAcceptanceSchema.parse(value);
      assertBridgeCorrelation(acceptance, request);
      if (acceptance.preparedHash !== binding.preparedHash) {
        throw new NativeBridgeError("protocol-error", "The accepted binding differs from the prepared binding.");
      }
      return null;
    }
    if (Date.now() >= deadline) {
      throw new NativeBridgeError("handshake-timeout", "The prepared invocation was not accepted.");
    }
    await sleep(25);
  }
}

async function runNative(request, invocation, journal) {
  const child = spawn(request.nativeExecutable, [...request.testExecutableArgs, ...invocation.nativeArguments], {
    cwd: request.workingDirectory, env: process.env, shell: false,
    windowsHide: true, detached: process.platform !== "win32",
    stdio: request.mode === "terminal" ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  let cancelled = false;
  let timeout = false;
  let forced = false;
  let failure = null;
  let recordingError = null;
  let stopping = null;
  const stop = (reason, error = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    cancelled ||= reason !== "timeout" && error === null;
    timeout ||= reason === "timeout";
    if (error !== null) failure = error;
    stopping ??= stopOwnedProcess(child).then(() => { forced = true; });
    return stopping;
  };
  const recordFailure = (error) => {
    recordingError ??= error;
    void stop("shutdown", { kind: "journal-error", message: errorMessage(error) })
      .catch((stopError) => { console.error("[CaseIQ bridge] Native stop failed:", stopError); });
  };
  const consume = (stream, name) => {
    stream.setEncoding("utf8");
    stream.on("data", (data) => {
      if (recordingError) return;
      stream.pause();
      journal.append("native-output", { stream: name, data })
        .then(() => stream.resume(), (error) => { recordFailure(error); stream.resume(); });
    });
  };
  const closed = new Promise((resolve) => {
    child.once("error", (error) => { failure = { kind: "native-spawn-error", message: error.message }; });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  if (child.stdout) consume(child.stdout, "stdout");
  if (child.stderr) consume(child.stderr, "stderr");
  if (child.stdin) child.stdin.end();
  if (child.pid) {
    try { await journal.append("native-spawn", { pid: child.pid }); }
    catch (error) { recordFailure(error); }
  }
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const control = await cancellation(request);
      if (control || timedOut(request)) await stop(control?.reason ?? "timeout");
    } catch (error) {
      await stop("shutdown", { kind: "protocol-error", message: errorMessage(error) })
        .catch((stopError) => { console.error("[CaseIQ bridge] Native stop failed:", stopError); });
    } finally { checking = false; }
  }, 25);
  const result = await closed;
  clearInterval(timer);
  if (stopping) await stopping;
  if (recordingError) throw recordingError;
  return {
    ...result, pid: child.pid ?? null, cancelled, timedOut: timeout, forced, error: failure,
  };
}

export async function trustAuthenticationWorkFolder(request, binding) {
  if (!request.trustWorkFolder) return;
  if (!request.authenticationOnly || request.mode !== "terminal" || !request.resume ||
      binding.sessionId !== request.sessionId || binding.workingDirectory !== await realpath(request.workingDirectory)) {
    throw new NativeBridgeError("protocol-error", "Authentication folder trust does not match its bound directory.");
  }
  const home = await realpath(binding.home);
  const file = path.join(home, "config.json");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BRIDGE_FILE_BYTES) {
    throw new NativeBridgeError("protocol-error", "Native trust configuration must be a bounded regular file.");
  }
  const configuration = JSON5.parse(await readFile(file, "utf8"));
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration) ||
      configuration.trustedFolders !== undefined && (!Array.isArray(configuration.trustedFolders) ||
        configuration.trustedFolders.some((value) => typeof value !== "string"))) {
    throw new NativeBridgeError("protocol-error", "Native trust configuration is invalid.");
  }
  const folders = configuration.trustedFolders ?? [];
  if (!folders.includes(binding.workingDirectory)) {
    await writeJson(file, { ...configuration, trustedFolders: [...folders, binding.workingDirectory] });
  }
}

async function stageAuthenticationObserver(request, binding) {
  if (!request.authenticationOnly) return null;
  const parent = path.join(binding.home, "extensions");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new NativeBridgeError("protocol-error", "Authentication observer directory is unsafe.");
  const directory = path.join(parent, `workboard-auth-${request.attemptId}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    await copyFile(fileURLToPath(new URL("./caseiq-auth-observer.mjs", import.meta.url)), path.join(directory, "extension.mjs"));
    await writeFile(path.join(directory, "context.json"), JSON.stringify({
      correlation: bridgeCorrelation(request), sessionId: request.sessionId,
      preparedHash: binding.preparedHash, requestDirectory: request.requestDirectory,
    }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
  return directory;
}

export async function executeInvocation(file) {
  const originalInvocation = nativeBridgeInvocationSchema.parse(await readJson(file));
  const request = await checkedRequest(originalInvocation.requestFile);
  const invocation = applyMcpToolApprovals(request, originalInvocation);
  if (await realpath(path.dirname(file)) !== request.requestDirectory) {
    throw new NativeBridgeError("protocol-error", "The invocation is outside this attempt directory.");
  }
  const journal = await createJournal(request);
  let result;
  let observerDirectory = null;
  try {
    const binding = await prepareBinding(request, invocation);
    await journal.append("prepared", { binding });
    const stopped = await waitForAcceptance(request, binding);
    if (!stopped) {
      await trustAuthenticationWorkFolder(request, binding);
      observerDirectory = await stageAuthenticationObserver(request, binding);
    }
    result = stopped ? {
      pid: null, exitCode: null, signal: null,
      cancelled: stopped !== "timeout", timedOut: stopped === "timeout", forced: false, error: null,
    } : await runNative(request, invocation, journal);
  } catch (error) {
    result = {
      pid: null, exitCode: null, signal: null, cancelled: false, timedOut: false, forced: false,
      error: { kind: error instanceof NativeBridgeError ? error.kind : "protocol-error", message: errorMessage(error) },
    };
  }
  try {
    const event = await journal.append("native-result", result);
    await writeJson(path.join(request.requestDirectory, "native-result.json"), event);
  } finally {
    await journal.close();
    if (observerDirectory) await rm(observerDirectory, { recursive: true });
  }
  if (result.cancelled) return 130;
  if (result.timedOut) return 124;
  return result.error ? 1 : portableExitCode(result.exitCode);
}

function portableExitCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

export async function finalizeLauncher(file, launcherExitCode, scriptError) {
  const request = await checkedRequest(file);
  const value = await readOptionalJson(path.join(request.requestDirectory, "native-result.json"));
  const native = value === null ? null : nativeBridgeFrameSchema.parse(value);
  if (native) assertBridgeCorrelation(native, request);
  if (native && native.kind !== "native-result") {
    throw new NativeBridgeError("protocol-error", "The native result file has the wrong frame kind.");
  }
  const bridgeExitCode = scriptError || native === null ? 1
    : launcherExitCode !== 0 ? portableExitCode(launcherExitCode)
    : native.error ? 1 : native.cancelled ? 130 : native.timedOut ? 124 : portableExitCode(native.exitCode);
  const result = launcherResultSchema.parse({
    ...bridgeCorrelation(request),
    launcherExitCode, nativeExitCode: native?.exitCode ?? null,
    bridgeExitCode, scriptError, nativeExecutionObserved: native === null ? null : native.pid !== null,
    errorKind: scriptError ? "launcher-script-error" : native === null ? "native-result-missing"
      : native.error?.kind ?? (bridgeExitCode !== 0 ? "native-process-failed" : null),
  });
  await writeJson(path.join(request.requestDirectory, "launcher-result.json"), result);
  return bridgeExitCode;
}

async function main() {
  const [operation, file, exitCode, scriptError] = process.argv.slice(2);
  if (!file || !path.isAbsolute(file)) throw new NativeBridgeError("protocol-error", "An absolute bridge file is required.");
  if (operation === "validate" && process.argv.length === 4) {
    await validateRequestFile(file);
    return 0;
  }
  if (operation === "execute" && process.argv.length === 4) return executeInvocation(file);
  if (operation === "finalize" && process.argv.length === 6 &&
      /^-?\d+$/.test(exitCode) && ["0", "1"].includes(scriptError)) {
    return finalizeLauncher(file, Number(exitCode), scriptError === "1");
  }
  throw new NativeBridgeError("protocol-error", "Unknown native bridge operation.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[CaseIQ bridge] ${error instanceof NativeBridgeError ? error.kind : "protocol-error"}: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
