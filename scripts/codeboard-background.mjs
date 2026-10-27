#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, openSync, readFileSync, readlinkSync, realpathSync,
  rmSync, statSync,
} from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { nextHostnameArgs, resolveRuntimeAuthMode } from "./auth-mode.mjs";
import {
  assertSafePath, createAutostartManager, ensurePrivateDirectory,
  isPositivePid, isProcessAlive, loadRuntimeEnvironment, readOptionalText,
  resolveAutostartEnabled, withLifecycleLock, writePrivateFile,
} from "./autostart.mjs";

function checkedResult(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect managed process with ${path.basename(binary)} (${result.error?.code ?? result.status}).`);
  }
  return result.stdout.trim();
}

const nextProcessTitle = /^next-server \(v[\w.+-]+\)$/;

function matchesNextCli(command, nextBin, port, platform) {
  const invocation = command.match(
    /^\s*(?:"[^"]+"|[^\s"]+)\s+(?:"([^"]+)"|([^\s"]+))\s+start\s+-p\s+(\d+)(?:\s|$)/,
  );
  if (!invocation || Number(invocation[3]) !== port) return false;
  const script = invocation[1] ?? invocation[2];
  return platform === "win32"
    ? script.replaceAll("\\", "/").toLowerCase() === nextBin.replaceAll("\\", "/").toLowerCase()
    : script === nextBin;
}

export function inspectManagedProcess(pid, root, platform = process.platform, port = 3100) {
  if (!isPositivePid(pid)) throw new Error("Refusing an invalid managed PID.");
  if (!isProcessAlive(pid)) return null;
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  if (platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; try { $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($null -eq $p){'null'; exit 0}; $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; @{command=$p.CommandLine; executable=$p.ExecutablePath; created=$p.CreationDate.ToUniversalTime().ToString('o'); owned=($owner.ReturnValue -eq 0 -and $owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)} | ConvertTo-Json -Compress } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    const value = JSON.parse(checkedResult(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    ));
    if (!value) return null;
    const isNext = matchesNextCli(value.command ?? "", nextBin, port, platform);
    return {
      ...value,
      executable: value.executable ? realpathSync(value.executable) : null,
      root: isNext ? root : null, isNext,
    };
  }
  if (platform === "linux") {
    try {
      const proc = `/proc/${pid}`;
      const fields = readFileSync(path.join(proc, "stat"), "utf8").split(") ")[1].split(" ");
      const args = readFileSync(path.join(proc, "cmdline"), "utf8").split("\0");
      return {
        root: realpathSync(path.join(proc, "cwd")),
        executable: readlinkSync(path.join(proc, "exe")),
        created: fields[19], group: Number(fields[2]),
        owned: statSync(proc).uid === process.getuid(),
        isNext: nextProcessTitle.test(args[0]) ||
          (args[1] === nextBin && args[2] === "start" && args[3] === "-p" && args[4] === String(port)),
      };
    } catch (error) {
      if (error.code === "ENOENT" && !isProcessAlive(pid)) return null;
      throw error;
    }
  }
  const details = checkedResult("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,pgid=,args="]);
  const match = details.match(/^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\d+)\s+([\s\S]+)$/);
  if (!match) throw new Error("Cannot verify managed process owner/start time.");
  const files = checkedResult("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd,txt", "-Ffn"])
    .split(/\r?\n/);
  const cwd = files.indexOf("fcwd");
  return {
    root: files[cwd + 1]?.slice(1),
    executable: files.find((line, index) => line === `n${realpathSync(process.execPath)}` && files[index - 1] === "ftxt")?.slice(1),
    created: match[2], group: Number(match[3]),
    owned: Number(match[1]) === process.getuid(),
    isNext: nextProcessTitle.test(match[4].trim()) || matchesNextCli(match[4], nextBin, port, platform),
  };
}

function httpIsReady(port) {
  return new Promise((resolve) => {
    const connection = request({
      host: "127.0.0.1", port, path: "/api/health", timeout: 1_500,
    }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    connection.once("timeout", () => connection.destroy());
    connection.once("error", () => resolve(false));
    connection.end();
  });
}

export async function runBackground(action, options = {}) {
  const root = realpathSync(options.root ?? path.resolve(import.meta.dirname, ".."));
  const platform = options.platform ?? process.platform;
  const dataDir = path.join(root, "data");
  const pidFile = path.join(dataDir, "codeboard.pid.json");
  const stdoutLog = path.join(dataDir, "codeboard.out.log");
  const stderrLog = path.join(dataDir, "codeboard.err.log");
  const port = options.port ?? 3100;
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const prismaBin = path.join(root, "node_modules", "prisma", "build", "index.js");
  const manager = options.manager ?? createAutostartManager({ root });
  const inspect = options.inspect ?? ((pid) => inspectManagedProcess(pid, root, platform, port));
  const alive = options.isAlive ?? isProcessAlive;
  const spawnProcess = options.spawn ?? spawn;
  const command = options.command ?? spawnSync;
  const ready = options.httpReady ?? (() => httpIsReady(port));
  const output = options.output ?? console;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startupTimeout = options.startupTimeoutMs ?? 15_000;
  const stopTimeout = options.stopTimeoutMs ?? 8_000;
  const inherited = options.environment ?? process.env;

  function readPid() {
    assertSafePath(pidFile);
    const text = readOptionalText(pidFile);
    if (text === null) return null;
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw new Error(`Invalid PID state: ${pidFile}. Inspect it before retrying.`);
    }
    if (!isPositivePid(state.pid)) throw new Error(`Unsafe PID in ${pidFile}; refusing to signal it.`);
    return state;
  }

  function removePid(state) {
    const current = readPid();
    if (current && JSON.stringify(current) === JSON.stringify(state)) rmSync(pidFile);
  }

  function identity(state) {
    const current = inspect(state.pid);
    if (!current) return null;
    const expectedNode = state.nodePath ?? realpathSync(process.execPath);
    const equalPath = (first, second) => platform === "win32"
      ? first?.toLowerCase() === second.toLowerCase() : first === second;
    if (!current.owned || !current.isNext || !equalPath(current.root, root) ||
      !equalPath(current.executable, expectedNode) ||
      (state.root && !equalPath(state.root, root)) ||
      (state.processInstance && current.created !== state.processInstance)) {
      throw new Error(`PID ${state.pid} is not this checkout's managed process instance; refusing to adopt or stop it.`);
    }
    return current;
  }

  async function portIsOpen() {
    if (options.portIsOpen) return options.portIsOpen();
    return new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      const close = () => { socket.destroy(); resolve(false); };
      socket.once("error", close);
      socket.once("timeout", close);
    });
  }

  function run(binary, args, environment) {
    const result = command(binary, args, {
      cwd: root, env: environment, stdio: "inherit", windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${path.basename(binary)} ${args[1] ?? ""} failed (${result.error?.code ?? result.status}).`);
    }
  }

  function reconcileAutostart(environment, pid) {
    try {
      const registration = manager.sync(environment);
      output.log(`Login autostart: ${registration.enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      throw new Error(`Work Board is running (PID ${pid}), but autostart reconciliation failed: ${error.message} Retry npm run autostart:sync.`);
    }
  }

  async function stopProcess(assertOwner) {
    const state = readPid();
    if (!state) {
      output.log("Work Board is not running (no PID file found).");
      return;
    }
    const current = identity(state);
    if (!current) {
      removePid(state);
      output.log("Work Board was not running; removed its stale PID file.");
      return;
    }
    assertOwner();
    if (platform === "win32") {
      const result = command(
        path.join(inherited.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(state.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" },
      );
      if ((result.error || result.status !== 0) && identity(state)) {
        throw new Error(`Failed to stop managed PID ${state.pid} (${result.error?.code ?? result.status}).`);
      }
    } else {
      const target = state.mode === "detached" && current.group === state.pid ? -state.pid : state.pid;
      const signal = options.signal ?? ((pid, value) => process.kill(pid, value));
      if (identity(state)) signal(target, "SIGTERM");
      const deadline = Date.now() + stopTimeout;
      while (identity(state) && Date.now() < deadline) await sleep(100);
      if (identity(state)) signal(target, "SIGKILL");
    }
    const deadline = Date.now() + stopTimeout;
    while (identity(state) && Date.now() < deadline) await sleep(100);
    if (identity(state)) throw new Error(`Managed PID ${state.pid} did not stop; retained its PID state.`);
    removePid(state);
    output.log("Work Board stopped.");
  }

  async function start(assertOwner, login) {
    let environment = loadRuntimeEnvironment(root, inherited);
    const enabled = resolveAutostartEnabled(environment);
    if (login) {
      if (!enabled) {
        output.log("Work Board login startup is disabled by WORKBOARD_AUTOSTART=false.");
        return null;
      }
      const authorization = manager.authorize(options.generation);
      if (!authorization) {
        output.log("Work Board login startup was removed, replaced, or revoked; not starting.");
        return null;
      }
      const delimiter = platform === "win32" ? ";" : ":";
      environment = { ...environment, PATH: [...new Set([
        ...authorization.pathEntries,
        ...(environment.PATH ?? environment.Path ?? "").split(delimiter),
      ].filter(Boolean))].join(delimiter) };
    }
    const mode = resolveRuntimeAuthMode(environment);
    const existing = readPid();
    if (existing) {
      if (identity(existing)) {
        if (!(await ready())) throw new Error("The managed Work Board process is alive but not HTTP-ready; inspect background:logs.");
        if (!identity(existing)) throw new Error("The managed process instance exited during its HTTP readiness check.");
        assertOwner();
        if (!login) reconcileAutostart(environment, existing.pid);
        output.log(`Work Board is already running (PID ${existing.pid}) at http://localhost:${port}.`);
        return null;
      }
      removePid(existing);
    }
    if (await portIsOpen()) {
      throw new Error(`Port ${port} is already in use by an unmanaged process. Stop it from its original owner; Work Board will not adopt or kill it.`);
    }
    if (!login && !options.skipBuild) {
      output.log("[Work Board] Generating Prisma client...");
      run(process.execPath, [prismaBin, "generate"], environment);
      output.log("[Work Board] Applying database migrations...");
      run(process.execPath, [prismaBin, "migrate", "deploy"], environment);
      output.log("[Work Board] Building release...");
      run(process.execPath, [nextBin, "build"], environment);
    }
    if (!existsSync(path.join(root, ".next", "BUILD_ID")) || !existsSync(nextBin)) {
      throw new Error("No prepared Work Board Release found. Run npm run background:start explicitly to prepare it; login startup never builds or migrates.");
    }
    ensurePrivateDirectory(dataDir);
    assertSafePath(stdoutLog);
    assertSafePath(stderrLog);
    const stdout = openSync(stdoutLog, "a", 0o600);
    const stderr = openSync(stderrLog, "a", 0o600);
    const supervised = login && platform !== "win32";
    let child;
    try {
      assertOwner();
      child = spawnProcess(process.execPath, [nextBin, "start", "-p", String(port), ...nextHostnameArgs(environment)], {
        cwd: root, detached: !supervised, windowsHide: true,
        stdio: ["ignore", stdout, stderr], env: environment,
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    let exited = false;
    let spawnError;
    let stopping = false;
    const completion = new Promise((resolve) => {
      child.once("error", (error) => { spawnError = error; exited = true; resolve(1); });
      child.once("exit", (code, signal) => {
        exited = true;
        resolve(code ?? (stopping && signal ? 0 : 1));
      });
    });
    const forwardSignal = (signal) => {
      stopping = true;
      child.kill(signal);
    };
    const onTerm = () => forwardSignal("SIGTERM");
    const onInt = () => forwardSignal("SIGINT");
    if (supervised) {
      process.once("SIGTERM", onTerm);
      process.once("SIGINT", onInt);
    }
    const removeSignalHandlers = () => {
      process.removeListener("SIGTERM", onTerm);
      process.removeListener("SIGINT", onInt);
    };
    let state;
    try {
      if (!isPositivePid(child.pid)) {
        await completion;
        throw new Error(`Cannot launch Work Board (${spawnError?.code ?? "missing child PID"}).`);
      }
      const deadline = Date.now() + startupTimeout;
      let current;
      let healthy = false;
      while (!exited && Date.now() < deadline) {
        current = inspect(child.pid);
        if (current?.owned && current.root === root && current.isNext &&
          current.executable === realpathSync(process.execPath) &&
          typeof current.created === "string" && current.created &&
          await ready() && !exited) {
          const confirmed = inspect(child.pid);
          if (!confirmed?.owned || !confirmed.isNext || confirmed.root !== root ||
            confirmed.executable !== current.executable || confirmed.created !== current.created) {
            throw new Error("The new managed process instance changed during its HTTP readiness check.");
          }
          current = confirmed;
          healthy = true;
          break;
        }
        await sleep(100);
      }
      if (!healthy) throw new Error(`Work Board did not become HTTP-ready. Check ${stderrLog}${spawnError ? ` (${spawnError.code})` : ""}.`);
      state = {
        pid: child.pid, startedAt: new Date().toISOString(), port, root,
        nodePath: current.executable, processInstance: current.created,
        mode: supervised ? "supervised" : "detached", generation: randomUUID(),
      };
      assertOwner();
      writePrivateFile(pidFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      removeSignalHandlers();
      if (!exited && isPositivePid(child.pid) && alive(child.pid)) {
        // This is our still-attached ChildProcess, not a PID recovered from disk.
        child.kill("SIGTERM");
        await Promise.race([completion, sleep(stopTimeout)]);
        if (!exited) throw new Error(`${error.message} The spawned process could not be stopped; inspect PID ${child.pid}.`);
      }
      throw error;
    }
    output.log(`Work Board started ${supervised ? "under the user service manager" : "in the background"} (PID ${child.pid}) at http://localhost:${port}.`);
    if (mode === "local") output.log("Login-free local mode is bound to 127.0.0.1 only.");
    output.log(`Logs: ${stdoutLog} and ${stderrLog}`);
    if (!supervised) child.unref();
    if (!login) reconcileAutostart(environment, child.pid);
    return supervised ? { child, completion, state, removeSignalHandlers } : null;
  }

  async function status() {
    const state = readPid();
    if (state && identity(state)) {
      output.log(`Work Board is running (PID ${state.pid}) at http://localhost:${state.port ?? port}${await ready() ? "" : " (HTTP not ready)"}.`);
    } else {
      if (state) removePid(state);
      output.log(`Work Board is not managed${await portIsOpen() ? `; port ${port} is in use by an unmanaged process` : " or running"}.`);
    }
    const result = manager.status();
    output.log(`Login autostart: ${result.enabled ? "enabled" : result.installed ? "disabled" : "absent"}.`);
    try {
      output.log(`Configured autostart intent: ${resolveAutostartEnabled(loadRuntimeEnvironment(root, inherited)) ? "enabled" : "disabled"}.`);
    } catch (error) {
      output.error(`Configuration error: ${error.message} Stop/remove remain available.`);
      throw error;
    }
  }

  function logs() {
    output.log(`stdout: ${stdoutLog}\nstderr: ${stderrLog}\nBootstrap: ${manager.log}`);
    for (const [label, file] of [["stdout", stdoutLog], ["stderr", stderrLog], ["bootstrap", manager.log]]) {
      assertSafePath(file);
      output.log(`\n--- ${label} (last 40 lines) ---`);
      const text = readOptionalText(file);
      output.log(text === null ? `No ${label} log yet.` : text.trimEnd().split(/\r?\n/).slice(-40).join("\n"));
    }
  }

  if (action === "status") return withLifecycleLock(root, status);
  if (action === "logs") return logs();
  if (!["start", "restart", "stop", "login"].includes(action)) {
    throw new Error("Usage: node scripts/codeboard-background.mjs <start|stop|restart|status|logs> [--skip-build]");
  }
  const result = await withLifecycleLock(root, async (assertOwner) => {
    if (action === "stop") {
      const failures = [];
      try {
        manager.remove();
        output.log("Work Board login autostart removed.");
      } catch (error) {
        failures.push(`Autostart cleanup failed: ${error.message}`);
      }
      try {
        await stopProcess(assertOwner);
      } catch (error) {
        failures.push(`Process shutdown failed: ${error.message}`);
      }
      if (failures.length) throw new Error(failures.join("\n"));
      return null;
    }
    if (action === "restart") await stopProcess(assertOwner);
    return start(assertOwner, action === "login");
  });
  if (result) {
    try {
      const code = await result.completion;
      let intentionallyReplaced = false;
      await withLifecycleLock(root, () => {
        const current = readPid();
        intentionallyReplaced = current
          ? current.generation !== result.state.generation
          : code !== 0 && !manager.authorize(options.generation);
        removePid(result.state);
      });
      if (code !== 0 && !intentionallyReplaced) {
        throw new Error(`Supervised Work Board exited with code ${code}; inspect background:logs.`);
      }
    } finally {
      result.removeSignalHandlers();
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runBackground(process.argv[2]?.toLowerCase(), {
    skipBuild: process.argv.includes("--skip-build"),
    generation: process.argv[2] === "login" ? process.argv[3] : undefined,
  }).catch((error) => {
    console.error(`[Work Board] ${error.message}`);
    if (process.argv[2] === "login") {
      try {
        const manager = createAutostartManager();
        ensurePrivateDirectory(manager.directory);
        assertSafePath(manager.log);
        appendFileSync(manager.log, `${new Date().toISOString()} ${error.message}\n`, { mode: 0o600 });
      } catch (logError) {
        console.error(`[Work Board] Cannot write login bootstrap diagnostics: ${logError.message}`);
      }
    }
    process.exitCode = 1;
  });
}
