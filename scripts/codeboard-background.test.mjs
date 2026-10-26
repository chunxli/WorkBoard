import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { inspectManagedProcess, runBackground } from "./codeboard-background.mjs";
import { resolveAutostartEnabled, withLifecycleLock, writePrivateFile } from "./autostart.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(settings = {}) {
  const root = realpathSync(mkdtempSync(path.join("scripts", ".workboard-background-")));
  directories.push(root);
  writePrivateFile(path.join(root, ".next", "BUILD_ID"), "prepared-test-build");
  writePrivateFile(path.join(root, "node_modules", "next", "dist", "bin", "next"), "test-only");
  const pidFile = path.join(root, "data", "codeboard.pid.json");
  const processes = new Map();
  const children = [];
  const calls = [];
  const messages = [];
  let counter = 4100;
  const manager = {
    enabled: false,
    generation: "registration-generation",
    log: path.join(root, "bootstrap.log"),
    sync(environment) {
      calls.push(["sync", environment.WORKBOARD_AUTOSTART]);
      this.enabled = resolveAutostartEnabled(environment);
      return { enabled: this.enabled };
    },
    remove() {
      calls.push(["remove"]);
      this.enabled = false;
      return { installed: false, enabled: false };
    },
    status() {
      return { installed: this.enabled, enabled: this.enabled };
    },
    authorize(generation) {
      return this.enabled && generation === this.generation ? { pathEntries: [] } : null;
    },
  };
  function exit(child, code = 0, signal = null) {
    processes.delete(child.pid);
    queueMicrotask(() => child.emit("exit", code, signal));
  }
  const options = {
    root, platform: "win32", environment: {}, manager,
    generation: manager.generation, skipBuild: true,
    startupTimeoutMs: 100, stopTimeoutMs: 100,
    output: { log: (message) => messages.push(message), error: (message) => messages.push(message) },
    inspect: (pid) => processes.get(pid) ?? null,
    isAlive: (pid) => processes.has(pid),
    portIsOpen: async () => processes.size > 0,
    httpReady: async () => true,
    spawn(binary, args, spawnOptions) {
      const child = new EventEmitter();
      child.pid = ++counter;
      child.unref = vi.fn();
      child.kill = vi.fn((signal) => { exit(child, null, signal); return true; });
      child.spawnOptions = spawnOptions;
      child.args = args;
      child.binary = binary;
      processes.set(child.pid, {
        owned: true, isNext: true, root, executable: realpathSync(process.execPath),
        created: `instance-${child.pid}`, group: child.pid,
      });
      children.push(child);
      calls.push(["spawn"]);
      return child;
    },
    command(binary, args) {
      calls.push(["command", binary, args]);
      if (binary.endsWith("taskkill.exe")) {
        const child = children.find((value) => value.pid === Number(args[1]));
        if (child) exit(child);
        else processes.delete(Number(args[1]));
      }
      return { status: 0 };
    },
    signal(pid, signal) {
      calls.push(["signal", pid, signal]);
      const child = children.find((value) => value.pid === Math.abs(pid));
      if (child) exit(child, null, signal);
      else processes.delete(Math.abs(pid));
    },
    ...settings,
  };
  function existing(overrides = {}, details = {}) {
    const state = {
      pid: 3900, port: 3100, root, nodePath: realpathSync(process.execPath),
      processInstance: "original-instance", generation: "original-state", mode: "detached", ...overrides,
    };
    processes.set(state.pid, {
      owned: true, isNext: true, root, executable: realpathSync(process.execPath),
      created: "original-instance", group: state.pid, ...details,
    });
    writePrivateFile(pidFile, JSON.stringify(state));
    return state;
  }
  return { root, pidFile, options, processes, children, calls, messages, manager, existing, exit };
}

describe("background autostart lifecycle", () => {
  it("starts a prepared Release and registers only after readiness", async () => {
    const f = fixture();
    await runBackground("start", f.options);
    expect(f.calls.map((call) => call[0])).toEqual(["spawn", "sync"]);
    expect(f.children[0].spawnOptions.windowsHide).toBe(true);
    expect(f.children[0].spawnOptions.detached).toBe(true);
    expect(f.children[0].args.slice(-2)).toEqual(["-H", "127.0.0.1"]);
    expect(f.children[0].unref).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(f.pidFile, "utf8")).processInstance).toBe("instance-4101");
  });

  it("waits for HTTP readiness before persisting PID success or reconciling registration", async () => {
    const f = fixture({ startupTimeoutMs: 1_000, sleep: async () => {} });
    let checks = 0;
    f.options.httpReady = async () => {
      expect(existsSync(f.pidFile)).toBe(false);
      expect(f.manager.enabled).toBe(false);
      f.calls.push(["ready", ++checks]);
      return checks === 2;
    };
    await runBackground("start", f.options);
    expect(f.calls.map((call) => call[0])).toEqual(["spawn", "ready", "ready", "sync"]);
    expect(existsSync(f.pidFile)).toBe(true);
  });

  it("preserves explicit full-build commands and never registers before they succeed", async () => {
    const f = fixture({ skipBuild: false });
    await runBackground("start", f.options);
    const args = f.calls.filter((call) => call[0] === "command").map((call) => call[2].slice(1));
    expect(args).toEqual([["generate"], ["migrate", "deploy"], ["build"]]);
    expect(f.calls.at(-1)[0]).toBe("sync");
  });

  it.each(["generate", "migrate", "build"])("never spawns or registers after a failed %s command", async (step) => {
    const f = fixture({ skipBuild: false });
    f.options.command = (_binary, args) => ({ status: args[1] === step ? 9 : 0 });
    await expect(runBackground("start", f.options)).rejects.toThrow("failed (9)");
    expect(f.calls).toEqual([]);
    expect(existsSync(f.pidFile)).toBe(false);
    expect(f.children).toHaveLength(0);
  });

  it.each(["start", "login"])("rejects invalid intent before side effects for %s", async (action) => {
    const f = fixture();
    f.manager.enabled = true;
    writeFileSync(path.join(f.root, ".env"), "WORKBOARD_AUTOSTART=invalid\n");
    await expect(runBackground(action, f.options)).rejects.toThrow("must be true or false");
    expect(f.calls).toEqual([]);
    expect(f.manager.enabled).toBe(true);
    expect(existsSync(f.pidFile)).toBe(false);
  });

  it("allows manual start with false while reconciling registration to disabled", async () => {
    const f = fixture({ environment: { WORKBOARD_AUTOSTART: "false" } });
    f.manager.enabled = true;
    await runBackground("start", f.options);
    expect(f.children).toHaveLength(1);
    expect(f.manager.enabled).toBe(false);
  });

  it("passes Entra authentication only to the child without persisting credentials in PID state or diagnostics", async () => {
    const environment = {
      AUTH_MICROSOFT_ENTRA_ID_ID: "fixture-client",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "fixture-entra-secret",
      AUTH_SECRET: "fixture-auth-secret",
      GH_TOKEN: "fixture-github-token",
    };
    const f = fixture({ environment });
    await runBackground("start", f.options);
    expect(f.children[0].args).not.toContain("-H");
    expect(f.children[0].spawnOptions.env).toMatchObject(environment);
    expect(readFileSync(f.pidFile, "utf8") + f.messages.join("\n"))
      .not.toMatch(/fixture-client|fixture-entra-secret|fixture-auth-secret|fixture-github-token/);
  });

  it.each(["AUTH_MICROSOFT_ENTRA_ID_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET"])(
    "rejects partial background authentication (%s) before spawn or reconciliation",
    async (key) => {
      const f = fixture({ environment: { [key]: "fixture-credential" } });
      await expect(runBackground("start", f.options)).rejects.toThrow("Set both");
      expect(f.calls).toEqual([]);
      expect(f.children).toHaveLength(0);
    },
  );

  it("reconciles an already-running exact instance without spawning again", async () => {
    const f = fixture();
    f.existing();
    await runBackground("start", f.options);
    expect(f.children).toHaveLength(0);
    expect(f.manager.enabled).toBe(true);
  });

  it("reports running state and recovery when reconciliation fails for an already-running instance", async () => {
    const f = fixture();
    f.existing();
    f.manager.sync = () => { throw new Error("native permission denied"); };
    const failure = await runBackground("start", f.options).catch((error) => error);
    expect(f.processes.has(3900)).toBe(true);
    expect(existsSync(f.pidFile)).toBe(true);
    expect(f.children).toHaveLength(0);
    expect(failure).toBeInstanceOf(Error);
    expect([...f.messages, failure.message].join("\n"))
      .toMatch(/running[\s\S]*autostart[\s\S]*autostart:sync/);
  });

  it("rechecks the managed process birth after the already-running HTTP readiness await", async () => {
    const f = fixture();
    f.existing();
    f.options.httpReady = async () => {
      f.processes.set(3900, { ...f.processes.get(3900), created: "reused-during-http-check" });
      return true;
    };
    const outcome = await runBackground("start", f.options).then(
      () => "success", (error) => error,
    );
    expect({
      outcome: outcome instanceof Error ? "error" : outcome, registered: f.manager.enabled,
    }).toEqual({ outcome: "error", registered: false });
    expect(outcome.message).toContain("process instance");
    expect(f.calls).toEqual([]);
    expect(f.manager.enabled).toBe(false);
  });

  it("also rechecks a new child instance after HTTP readiness before persisting or registering it", async () => {
    const f = fixture();
    f.options.httpReady = async () => {
      f.processes.set(4101, { ...f.processes.get(4101), created: "replaced-during-new-readiness" });
      return true;
    };
    await expect(runBackground("start", f.options)).rejects.toThrow("process instance changed");
    expect(f.manager.enabled).toBe(false);
    expect(existsSync(f.pidFile)).toBe(false);
  });

  it("refuses unrelated port owners and never registers on failed startup", async () => {
    const f = fixture({ portIsOpen: async () => true });
    await expect(runBackground("start", f.options)).rejects.toThrow("unmanaged process");
    expect(f.calls).toEqual([]);
    expect(f.children).toHaveLength(0);
  });

  it("does not mistake a live but unhealthy managed process for startup success", async () => {
    const f = fixture({ httpReady: async () => false });
    f.existing();
    await expect(runBackground("start", f.options)).rejects.toThrow("not HTTP-ready");
    expect(f.manager.enabled).toBe(false);
  });

  it("does not build or migrate on login and respects revocation/current false", async () => {
    const f = fixture({ skipBuild: false });
    await runBackground("login", f.options);
    expect(f.calls).toEqual([]);
    f.manager.enabled = true;
    writeFileSync(path.join(f.root, ".env"), "WORKBOARD_AUTOSTART=false\n");
    f.options.environment.WORKBOARD_AUTOSTART = "true";
    await runBackground("login", f.options);
    expect(f.calls).toEqual([]);
    expect(f.messages.join("\n")).toContain("disabled");
  });

  it("starts an authorized Windows login invisibly from the saved Release only", async () => {
    const f = fixture({ skipBuild: false });
    f.manager.enabled = true;
    await runBackground("login", f.options);
    expect(f.calls.map((call) => call[0])).toEqual(["spawn"]);
    expect(f.children[0].spawnOptions.windowsHide).toBe(true);
  });

  it.each(["build", "Next dependency"])("reports a missing prepared %s without spawning/building on login", async (kind) => {
    const f = fixture();
    f.manager.enabled = true;
    rmSync(kind === "build" ? path.join(f.root, ".next", "BUILD_ID")
      : path.join(f.root, "node_modules", "next", "dist", "bin", "next"));
    await expect(runBackground("login", f.options)).rejects.toThrow("never builds or migrates");
    expect(f.calls).toEqual([]);
  });

  it("distinguishes installed-disabled intent from a live but HTTP-unready application in status", async () => {
    const f = fixture({
      environment: { WORKBOARD_AUTOSTART: "false" }, httpReady: async () => false,
    });
    f.existing();
    f.manager.status = () => ({ installed: true, enabled: false });
    await runBackground("status", f.options);
    expect(f.messages.join("\n")).toContain("running (PID 3900)");
    expect(f.messages.join("\n")).toContain("(HTTP not ready)");
    expect(f.messages).toContain("Login autostart: disabled.");
    expect(f.messages).toContain("Configured autostart intent: disabled.");
    expect(f.calls).toEqual([]);
    expect(existsSync(f.pidFile)).toBe(true);
  });

  it.each(["native permission denied", "Cannot inspect the current-user Work Board Run entry."])(
    "preserves a healthy process and reports registration partial failure (%s)", async (message) => {
    const f = fixture();
    f.manager.sync = () => { throw new Error(message); };
    await expect(runBackground("start", f.options)).rejects.toThrow("is running (PID 4101), but autostart");
    expect(f.processes.has(4101)).toBe(true);
    expect(existsSync(f.pidFile)).toBe(true);
  });

  it.each(["missing", "stale"])("unregisters on explicit stop with %s PID state", async (kind) => {
    const f = fixture();
    f.manager.enabled = true;
    if (kind === "stale") {
      f.existing();
      f.processes.clear();
    }
    await runBackground("stop", f.options);
    expect(f.manager.enabled).toBe(false);
    expect(f.calls).toEqual([["remove"]]);
    expect(existsSync(f.pidFile)).toBe(false);
  });

  it("an invalid configuration cannot block explicit stop/unregister", async () => {
    const f = fixture();
    f.existing();
    writeFileSync(path.join(f.root, ".env"), "WORKBOARD_AUTOSTART=invalid\n");
    await runBackground("stop", f.options);
    expect(f.calls[0]).toEqual(["remove"]);
    expect(f.processes.size).toBe(0);
    expect(existsSync(f.pidFile)).toBe(false);
  });

  it("attempts process shutdown even when registration cleanup fails", async () => {
    const f = fixture();
    f.existing();
    f.manager.remove = () => { throw new Error("unregister denied"); };
    await expect(runBackground("stop", f.options)).rejects.toThrow("Autostart cleanup failed");
    expect(f.processes.size).toBe(0);
  });

  it("reports both independent stop failures and preserves the still-running PID state", async () => {
    const f = fixture();
    f.existing();
    f.manager.remove = () => {
      f.calls.push(["remove"]);
      throw new Error("unregister denied");
    };
    f.options.command = (_binary, args) => {
      f.calls.push(["stop", args]);
      return { status: 5 };
    };
    const failure = await runBackground("stop", f.options).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("Autostart cleanup failed: unregister denied");
    expect(failure.message).toContain("Process shutdown failed: Failed to stop managed PID 3900 (5)");
    expect(f.calls.map((call) => call[0])).toEqual(["remove", "stop"]);
    expect(f.processes.has(3900)).toBe(true);
    expect(existsSync(f.pidFile)).toBe(true);
    expect(f.messages.join("\n")).not.toContain("Work Board stopped");
  });

  it("unregisters but refuses to signal a reused/foreign process", async () => {
    const f = fixture();
    f.existing({}, { created: "reused-pid" });
    await expect(runBackground("stop", f.options)).rejects.toThrow("process instance");
    expect(f.manager.enabled).toBe(false);
    expect(f.calls).toEqual([["remove"]]);
    expect(existsSync(f.pidFile)).toBe(true);
  });

  it.each([-1, 0, "3900"])("does not signal unsafe recovered PID %s", async (pid) => {
    const f = fixture();
    writePrivateFile(f.pidFile, JSON.stringify({ pid }));
    await expect(runBackground("stop", f.options)).rejects.toThrow("Unsafe PID");
    expect(f.calls).toEqual([["remove"]]);
  });

  it("restart's internal stop does not unregister, then reconciles after the new start", async () => {
    const f = fixture();
    f.existing();
    f.manager.enabled = true;
    await runBackground("restart", f.options);
    expect(f.calls.some((call) => call[0] === "remove")).toBe(false);
    expect(f.calls.at(-1)[0]).toBe("sync");
    expect(f.children).toHaveLength(1);
  });

  it("keeps full restart generation, migration and build semantics without unregistering", async () => {
    const f = fixture({ skipBuild: false });
    f.existing();
    f.manager.enabled = true;
    await runBackground("restart", f.options);
    const commands = f.calls.filter((call) => call[0] === "command");
    expect(commands[0][1]).toMatch(/taskkill\.exe$/);
    expect(commands.slice(1).map((call) => call[2].slice(1)))
      .toEqual([["generate"], ["migrate", "deploy"], ["build"]]);
    expect(f.calls.some((call) => call[0] === "remove")).toBe(false);
    expect(f.calls.at(-1)[0]).toBe("sync");
  });

  it("serializes login and manual starts into one process", async () => {
    const f = fixture();
    f.manager.enabled = true;
    await Promise.all([runBackground("login", f.options), runBackground("start", f.options)]);
    expect(f.children).toHaveLength(1);
  });

  it("a previously queued login authorization cannot undo explicit stop", async () => {
    const f = fixture();
    f.manager.enabled = true;
    f.existing();
    await runBackground("stop", f.options);
    await runBackground("login", f.options);
    expect(f.children).toHaveLength(0);
    expect(f.processes.size).toBe(0);
  });

  it.each(["registration", "configuration"])("rechecks revoked %s after waiting for the common lock", async (kind) => {
    const f = fixture();
    f.manager.enabled = true;
    const authorize = vi.spyOn(f.manager, "authorize");
    let release;
    const blocking = withLifecycleLock(f.root, async () => {
      await new Promise((resolve) => { release = resolve; });
      if (kind === "registration") f.manager.remove();
      else writeFileSync(path.join(f.root, ".env"), "WORKBOARD_AUTOSTART=false\n");
    });
    const queued = runBackground("login", f.options);
    expect(authorize).not.toHaveBeenCalled();
    release();
    await Promise.all([blocking, queued]);
    expect(f.children).toHaveLength(0);
    expect(f.processes.size).toBe(0);
    if (kind === "registration") expect(authorize).toHaveBeenCalledWith(f.options.generation);
    else expect(authorize).not.toHaveBeenCalled();
  });

  it("terminates its own failed startup rather than trusting an open port alone", async () => {
    const f = fixture({ startupTimeoutMs: 0 });
    await expect(runBackground("start", f.options)).rejects.toThrow("did not become HTTP-ready");
    expect(f.children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.processes.size).toBe(0);
    expect(existsSync(f.pidFile)).toBe(false);
    expect(f.manager.enabled).toBe(false);
  });

  it.each(["darwin", "linux"])("keeps %s login foreground, forwards signals, and preserves registration", async (platform) => {
    const f = fixture({ platform });
    f.manager.enabled = true;
    const previous = new Set(process.listeners("SIGTERM"));
    const running = runBackground("login", f.options);
    await vi.waitFor(() => expect(existsSync(f.pidFile)).toBe(true));
    expect(f.children[0].spawnOptions.detached).toBe(false);
    expect(f.children[0].unref).not.toHaveBeenCalled();
    const handler = process.listeners("SIGTERM").find((listener) => !previous.has(listener));
    expect(handler).toBeTypeOf("function");
    handler();
    await running;
    expect(f.children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(f.manager.enabled).toBe(true);
    expect(existsSync(f.pidFile)).toBe(false);
  });

  it.each(["darwin", "linux"])("forwards SIGINT and removes only its own %s supervisor signal listeners", async (platform) => {
    const f = fixture({ platform });
    f.manager.enabled = true;
    const beforeTerm = process.listeners("SIGTERM");
    const beforeInt = process.listeners("SIGINT");
    const running = runBackground("login", f.options);
    await vi.waitFor(() => expect(existsSync(f.pidFile)).toBe(true));
    const handler = process.listeners("SIGINT").find((listener) => !beforeInt.includes(listener));
    expect(handler).toBeTypeOf("function");
    handler();
    await running;
    expect(f.children[0].kill).toHaveBeenCalledWith("SIGINT");
    expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
    expect(process.listeners("SIGINT")).toEqual(beforeInt);
    expect(existsSync(f.pidFile)).toBe(false);
    expect(f.manager.enabled).toBe(true);
  });

  it.each(["darwin", "linux"])("reports a nonzero %s supervised exit and cleans only its PID generation", async (platform) => {
    const f = fixture({ platform });
    f.manager.enabled = true;
    const running = runBackground("login", f.options);
    await vi.waitFor(() => expect(existsSync(f.pidFile)).toBe(true));
    const completed = expect(running).rejects.toThrow("exited with code 7");
    f.exit(f.children[0], 7);
    await completed;
    expect(existsSync(f.pidFile)).toBe(false);
    expect(f.manager.enabled).toBe(true);
    expect(f.calls.map((call) => call[0])).toEqual(["spawn"]);
  });

  it("old supervised cleanup cannot remove replacement state or resurrect after explicit stop", async () => {
    const f = fixture({ platform: "linux" });
    f.manager.enabled = true;
    const running = runBackground("login", f.options);
    await vi.waitFor(() => expect(existsSync(f.pidFile)).toBe(true));
    await runBackground("restart", f.options);
    await running;
    expect(JSON.parse(readFileSync(f.pidFile, "utf8")).pid).toBe(4102);
    expect(f.manager.enabled).toBe(true);
    await runBackground("stop", f.options);
    await runBackground("login", f.options);
    expect(f.children).toHaveLength(2);
    expect(f.processes.size).toBe(0);
  });

  it.runIf(process.platform === "win32")(
    "does not identify an unrelated Node script sharing the Next CLI path prefix as managed Next",
    async () => {
      const f = fixture();
      const unrelated = path.join(f.root, "node_modules", "next", "dist", "bin", "next-diagnostic.cjs");
      writeFileSync(unrelated, "setInterval(() => {}, 1000);\n");
      const child = spawn(process.execPath, [unrelated, "start", "-p", "49999"], {
        cwd: f.root, windowsHide: true, stdio: "ignore",
        env: { SystemRoot: process.env.SystemRoot },
      });
      try {
        await once(child, "spawn");
        const inspected = inspectManagedProcess(child.pid, f.root, "win32", 49999);
        expect(inspected.owned).toBe(true);
        expect(inspected.isNext).toBe(false);
      } finally {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await exited;
        }
      }
    }, 20_000,
  );

  it.runIf(process.platform === "win32")(
    "verifies native Windows PID ownership/birth, HTTP readiness and stop on an isolated synthetic process",
    async () => {
      const reservation = createServer();
      await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      const f = fixture();
      writeFileSync(path.join(f.root, "node_modules", "next", "dist", "bin", "next"), `
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end("{}");
});
server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`);
      const children = [];
      const options = {
        root: f.root, port, manager: f.manager,
        environment: { SystemRoot: process.env.SystemRoot, WORKBOARD_AUTOSTART: "false" },
        skipBuild: true, startupTimeoutMs: 15_000, stopTimeoutMs: 8_000,
        output: f.options.output,
        spawn(binary, args, spawnOptions) {
          const child = spawn(binary, args, spawnOptions);
          children.push(child);
          return child;
        },
      };
      try {
        await runBackground("start", options);
        const state = JSON.parse(readFileSync(f.pidFile, "utf8"));
        expect(state.pid).toBe(children[0].pid);
        expect(state.processInstance).toMatch(/T.*Z$/);
        await runBackground("status", options);
        expect(f.messages.join("\n")).toContain("Work Board is running");
        await runBackground("stop", options);
        expect(existsSync(f.pidFile)).toBe(false);
        expect(f.manager.enabled).toBe(false);
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            await new Promise((resolve) => {
              child.once("exit", resolve);
              setTimeout(resolve, 1_000).unref();
            });
          }
        }
      }
    }, 30_000,
  );
});
