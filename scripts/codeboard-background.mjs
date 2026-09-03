#!/usr/bin/env node

import "dotenv/config";

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { nextHostnameArgs, resolveRuntimeAuthMode } from "./auth-mode.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, "data");
const pidFile = path.join(dataDir, "codeboard.pid.json");
const stdoutLog = path.join(dataDir, "codeboard.out.log");
const stderrLog = path.join(dataDir, "codeboard.err.log");
const port = 3100;
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const prismaBin = path.join(
  root,
  "node_modules",
  "prisma",
  "build",
  "index.js",
);
const action = process.argv[2]?.toLowerCase();
const skipBuild = process.argv.includes("--skip-build");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readPid() {
  try {
    const state = JSON.parse(readFileSync(pidFile, "utf8"));
    return Number.isInteger(state.pid) ? state : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return result.stdout?.trim() ?? "";
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.stdout?.trim() ?? "";
}

function processCwd(pid) {
  if (process.platform === "win32") return "";
  const result = spawnSync(
    "lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    {
      encoding: "utf8",
    },
  );
  return (
    result.stdout
      ?.split(/\r?\n/)
      .find((line) => line.startsWith("n"))
      ?.slice(1) ?? ""
  );
}

function isCodeBoardProcess(pid) {
  const command = processCommand(pid).replaceAll("\\", "/").toLowerCase();
  if (
    command.includes("next/dist/bin/next") &&
    command.includes(" start ") &&
    command.includes("-p 3100")
  ) {
    return true;
  }
  return (
    process.platform !== "win32" &&
    command.includes("next-server") &&
    processCwd(pid) === root
  );
}

function portOwnerPid() {
  if (process.platform === "win32") return null;
  const result = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  const pid = Number.parseInt(result.stdout?.trim().split(/\s+/)[0] ?? "", 10);
  return Number.isInteger(pid) ? pid : null;
}

function unmanagedCodeBoardPid() {
  const pid = portOwnerPid();
  return pid && isAlive(pid) && isCodeBoardProcess(pid) ? pid : null;
}

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const close = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", close);
    socket.once("timeout", close);
  });
}

async function waitForPort(expectedOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await portIsOpen()) === expectedOpen) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function start() {
  mkdirSync(dataDir, { recursive: true });
  const existing = readPid();
  if (existing && isAlive(existing.pid) && isCodeBoardProcess(existing.pid)) {
    console.log(
      `Work Board is already running (PID ${existing.pid}) at http://localhost:${port}.`,
    );
    return;
  }
  if (existing) rmSync(pidFile, { force: true });

  if (await portIsOpen()) {
    const pid = unmanagedCodeBoardPid();
    if (pid) {
      console.log(
        `Work Board is already running (PID ${pid}) at http://localhost:${port}; it is not managed by the background script.`,
      );
      return;
    }
    console.error(
      `Port ${port} is already in use. Stop that process before starting Work Board.`,
    );
    process.exit(1);
  }

  if (!skipBuild) {
    console.log("[Work Board] Generating Prisma client...");
    run(process.execPath, [prismaBin, "generate"]);
    console.log("[Work Board] Applying database migrations...");
    run(process.execPath, [prismaBin, "migrate", "deploy"]);
    console.log("[Work Board] Building release...");
    run(process.execPath, [nextBin, "build"]);
  }

  const stdout = openSync(stdoutLog, "a");
  const stderr = openSync(stderrLog, "a");
  const child = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(port), ...nextHostnameArgs()],
    {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
      env: process.env,
    },
  );
  child.unref();
  closeSync(stdout);
  closeSync(stderr);

  writeFileSync(
    pidFile,
    JSON.stringify(
      { pid: child.pid, startedAt: new Date().toISOString(), port },
      null,
      2,
    ) + "\n",
  );

  if (!(await waitForPort(true, 15_000))) {
    if (isAlive(child.pid) && isCodeBoardProcess(child.pid)) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        process.kill(-child.pid, "SIGTERM");
      }
    }
    rmSync(pidFile, { force: true });
    console.error(`Work Board did not start. Check ${stderrLog}.`);
    process.exit(1);
  }

  console.log(
    `Work Board started in the background (PID ${child.pid}) at http://localhost:${port}.`,
  );
  if (resolveRuntimeAuthMode() === "local") {
    console.log("Login-free local mode is bound to 127.0.0.1 only.");
  }
  console.log(`Logs: ${stdoutLog} and ${stderrLog}`);
}

async function stop() {
  const state = readPid();
  if (!state) {
    const pid = unmanagedCodeBoardPid();
    if (pid) {
      console.log(
        `Work Board is running (PID ${pid}) but is not managed by the background script. Stop it from its original terminal.`,
      );
      return;
    }
    console.log("Work Board is not running (no PID file found).\n");
    return;
  }
  if (!isAlive(state.pid)) {
    rmSync(pidFile, { force: true });
    console.log("CodeBoard was not running; removed its stale PID file.");
    return;
  }
  if (!isCodeBoardProcess(state.pid)) {
    console.error(
      `PID ${state.pid} is not a Work Board process; refusing to stop it.`,
    );
    process.exit(1);
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(state.pid), "/T", "/F"],
      {
        stdio: "inherit",
        windowsHide: true,
      },
    );
    if (result.status !== 0 && isAlive(state.pid))
      process.exit(result.status ?? 1);
  } else {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      process.kill(state.pid, "SIGTERM");
    }
    if (!(await waitForPort(false, 8_000)) && isAlive(state.pid)) {
      try {
        process.kill(-state.pid, "SIGKILL");
      } catch {
        process.kill(state.pid, "SIGKILL");
      }
    }
  }

  rmSync(pidFile, { force: true });
  console.log("Work Board stopped.");
}

function status() {
  const state = readPid();
  if (state && isAlive(state.pid) && isCodeBoardProcess(state.pid)) {
    console.log(
      `Work Board is running (PID ${state.pid}) at http://localhost:${state.port ?? port}.`,
    );
    return;
  }
  if (state) rmSync(pidFile, { force: true });
  const pid = unmanagedCodeBoardPid();
  if (pid) {
    console.log(
      `Work Board is running (PID ${pid}) at http://localhost:${port} (not managed by the background script).`,
    );
    return;
  }
  console.log("Work Board is not running.");
}

function logs() {
  console.log(`stdout: ${stdoutLog}`);
  console.log(`stderr: ${stderrLog}`);
  for (const [label, file] of [
    ["stdout", stdoutLog],
    ["stderr", stderrLog],
  ]) {
    console.log(`\n--- ${label} (last 40 lines) ---`);
    try {
      console.log(
        readFileSync(file, "utf8")
          .trimEnd()
          .split(/\r?\n/)
          .slice(-40)
          .join("\n"),
      );
    } catch {
      console.log(`No ${label} log yet.`);
    }
  }
}

async function restart() {
  await stop();
  await start();
}

switch (action) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await restart();
    break;
  case "status":
    status();
    break;
  case "logs":
    logs();
    break;
  default:
    console.error(
      "Usage: node scripts/codeboard-background.mjs <start|stop|restart|status|logs> [--skip-build]",
    );
    process.exit(1);
}
