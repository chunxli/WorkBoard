import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  isPositivePid,
  createAutostartManager,
  loadRuntimeEnvironment,
  renderWindowsLauncher,
  resolveAutostartEnabled,
  ensurePrivateDirectory,
  systemdArgument,
  withLifecycleLock,
  writePrivateFile,
  xmlString,
} from "./autostart.mjs";

const deniedReplacement = vi.hoisted(() => ({ file: null }));
vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal();
  return {
    ...filesystem,
    renameSync(source, destination) {
      if (destination === deniedReplacement.file) {
        throw Object.assign(new Error("Injected launcher replacement denial"), { code: "EACCES" });
      }
      return filesystem.renameSync(source, destination);
    },
  };
});

const directories = [];
function fixture() {
  const root = realpathSync(mkdtempSync(path.join("scripts", ".workboard-autostart-")));
  directories.push(root);
  return root;
}

afterEach(() => {
  deniedReplacement.file = null;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("autostart configuration", () => {
  it.each([undefined, "", "true", " TRUE "])("enables by default or true (%s)", (value) => {
    expect(resolveAutostartEnabled({ WORKBOARD_AUTOSTART: value })).toBe(true);
  });

  it.each(["false", " FALSE "])("disables for false (%s)", (value) => {
    expect(resolveAutostartEnabled({ WORKBOARD_AUTOSTART: value })).toBe(false);
  });

  it.each(["0", "yes", "invalid-secret-sentinel"])("rejects invalid values without echoing them (%s)", (value) => {
    expect(() => resolveAutostartEnabled({ WORKBOARD_AUTOSTART: value })).toThrow(
      "WORKBOARD_AUTOSTART must be true or false.",
    );
  });

  it("reads the requested checkout and gives its current flag precedence only", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, ".env"),
      'WORKBOARD_AUTOSTART="false"\nAUTH_SECRET="file-secret"\nDATABASE_URL="file:fixture.db"\n',
    );
    const environment = loadRuntimeEnvironment(root, {
      WORKBOARD_AUTOSTART: "true",
      AUTH_SECRET: "inherited-secret",
    });
    expect(resolveAutostartEnabled(environment)).toBe(false);
    expect(environment.AUTH_SECRET).toBe("inherited-secret");
    expect(environment.DATABASE_URL).toBe("file:fixture.db");
  });

  it("supports deployments without an environment file", () => {
    expect(loadRuntimeEnvironment(fixture(), { WORKBOARD_AUTOSTART: "false" }))
      .toEqual({ WORKBOARD_AUTOSTART: "false" });
  });
});

describe("owned lifecycle state", () => {
  it.each([-1, 0, 1.5, "123", 2_147_483_648, null])("rejects unsafe PID %s", (pid) => {
    expect(isPositivePid(pid)).toBe(false);
  });

  function nativeFixture(platform) {
    const root = fixture();
    const home = path.join(root, "home");
    const calls = [];
    let registry = null;
    let enabled = false;
    let disabled = false;
    let fail = () => false;
    let readResult = null;
    const command = (binary, args) => {
      calls.push({ binary, args });
      if (fail(binary, args)) return { status: 1, stderr: "permission denied" };
      if (binary.endsWith("powershell.exe")) {
        if (args.at(-1).includes("WORKBOARD_ACL_CHECK")) return { status: 0, stdout: "trusted" };
        return readResult ?? { status: 0, stdout: JSON.stringify({ value: registry }) };
      }
      if (binary.endsWith("wscript.exe")) return { status: 42, stdout: "" };
      if (binary.endsWith("reg.exe")) {
        registry = args[0] === "add" ? args[args.indexOf("/d") + 1] : null;
      }
      if (args.includes("is-enabled")) return { status: enabled ? 0 : 1, stdout: enabled ? "enabled\n" : "disabled\n" };
      if (args[1] === "enable") enabled = true;
      if (args[1] === "disable") enabled = false;
      if (args[0] === "enable") disabled = false;
      if (args[0] === "disable") disabled = true;
      if (args[0] === "print-disabled") return {
        status: 0, stdout: disabled ? `"${manager.id.replace("workboard-", "com.workboard.")}" => true` : "{}",
      };
      return { status: 0, stdout: "" };
    };
    const manager = createAutostartManager({
      root, home, platform, uid: 1000, command,
      nodePath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node",
      environment: {
        LOCALAPPDATA: path.join(home, "Local"),
        PATH: platform === "win32" ? "C:\\Tools;C:\\Windows\\System32" : "/usr/local/bin:/usr/bin",
        AUTH_SECRET: "DO-NOT-PERSIST-THIS-SECRET",
        GH_TOKEN: "DO-NOT-PERSIST-THIS-TOKEN",
      },
    });
    return { manager, calls, command, home, failWhen: (predicate) => { fail = predicate; },
      readAs: (result) => { readResult = result; } };
  }

  describe.each(["win32", "darwin", "linux"])("%s user registration adapter", (platform) => {
    it("registers, verifies, remains idempotent, and revokes queued launches on removal", () => {
      const { manager, calls } = nativeFixture(platform);
      expect(manager.status().installed).toBe(false);
      expect(manager.sync().enabled).toBe(true);
      const installed = JSON.parse(readFileSync(manager.stateFile, "utf8"));
      expect(manager.authorize(installed.generation)).not.toBeNull();
      manager.sync();
      expect(JSON.parse(readFileSync(manager.stateFile, "utf8")).generation).toBe(installed.generation);
      expect(manager.remove().installed).toBe(false);
      expect(manager.authorize(installed.generation)).toBeNull();
      expect(manager.remove().installed).toBe(false);
      expect(calls.every(({ args }) => !args.some((arg) => ["--now", "bootstrap", "bootout", "start", "stop"].includes(arg)))).toBe(true);
    });

    it("does not persist credentials or unrelated environment settings", () => {
      const { manager } = nativeFixture(platform);
      manager.sync();
      const persisted = readFileSync(manager.stateFile, "utf8") + readFileSync(manager.nativeFile, "utf8");
      expect(persisted).not.toMatch(/DO-NOT-PERSIST|AUTH_SECRET|GH_TOKEN/);
      expect(persisted).toContain("login");
      expect(persisted).not.toContain("migrate");
    });

    it("disables with false and re-enables only by explicit reconciliation", () => {
      const { manager } = nativeFixture(platform);
      manager.sync();
      const generation = JSON.parse(readFileSync(manager.stateFile, "utf8")).generation;
      expect(manager.sync({ WORKBOARD_AUTOSTART: "false" }).installed).toBe(false);
      expect(manager.authorize(generation)).toBeNull();
      expect(manager.sync({ WORKBOARD_AUTOSTART: "true" }).enabled).toBe(true);
      expect(manager.authorize(generation)).toBeNull();
    });

    it("rejects invalid intent but keeps owned removal and actual-state inspection usable", () => {
      const { manager } = nativeFixture(platform);
      manager.sync();
      expect(() => manager.sync({ WORKBOARD_AUTOSTART: "invalid" })).toThrow("must be true or false");
      expect(manager.status().enabled).toBe(true);
      expect(manager.remove().installed).toBe(false);
    });

    it("refuses to overwrite or remove a foreign/changed startup definition", () => {
      const { manager } = nativeFixture(platform);
      manager.sync();
      writeFileSync(manager.nativeFile, "foreign entry");
      expect(() => manager.remove()).toThrow(/changed|Conflicting/);
      expect(readFileSync(manager.nativeFile, "utf8")).toBe("foreign entry");
    });

    it("preserves foreign registration metadata and the native definition during cleanup", () => {
      const { manager, calls } = nativeFixture(platform);
      manager.sync();
      const definition = readFileSync(manager.nativeFile, "utf8");
      const foreign = JSON.stringify({
        ...JSON.parse(readFileSync(manager.stateFile, "utf8")), owner: "another-owner",
      });
      writeFileSync(manager.stateFile, foreign);
      const before = calls.length;
      expect(() => manager.remove()).toThrow("another installation");
      expect(readFileSync(manager.stateFile, "utf8")).toBe(foreign);
      expect(readFileSync(manager.nativeFile, "utf8")).toBe(definition);
      expect(calls.slice(before).some(({ args }) => args.some(
        (argument) => ["add", "delete", "enable", "disable"].includes(argument),
      ))).toBe(false);
    });

    it("restores a working registration and its generation if a Node-path replacement fails", () => {
      const { manager, command, home, failWhen } = nativeFixture(platform);
      manager.sync();
      const previous = JSON.parse(readFileSync(manager.stateFile, "utf8"));
      const replacement = createAutostartManager({
        root: manager.root, home, platform, uid: 1000, command,
        nodePath: platform === "win32" ? "C:\\replacement\\node.exe" : "/replacement/bin/node",
        environment: { LOCALAPPDATA: path.join(home, "Local") },
      });
      let failed = false;
      failWhen((binary, args) => {
        const installing = (platform === "win32" && binary.endsWith("reg.exe") && args[0] === "add") ||
          (platform === "darwin" && args[0] === "enable") ||
          (platform === "linux" && args[1] === "enable");
        if (!installing || failed) return false;
        failed = true;
        return true;
      });
      expect(() => replacement.sync()).toThrow(/registration failed.*permission denied/);
      expect(manager.status().enabled).toBe(true);
      expect(JSON.parse(readFileSync(manager.stateFile, "utf8"))).toEqual(previous);
      expect(readFileSync(manager.nativeFile, "utf8")).toBe(previous.definition);
      expect(manager.authorize(previous.generation)).not.toBeNull();
    });

    it("preserves the unchanged previous launcher, native entry and generation when replacement is denied", () => {
      const { manager, command, home, calls } = nativeFixture(platform);
      manager.sync();
      const previous = JSON.parse(readFileSync(manager.stateFile, "utf8"));
      const replacement = createAutostartManager({
        root: manager.root, home, platform, uid: 1000, command,
        nodePath: platform === "win32" ? "C:\\replacement\\node.exe" : "/replacement/bin/node",
        environment: { LOCALAPPDATA: path.join(home, "Local") },
      });
      const start = calls.length;
      deniedReplacement.file = manager.nativeFile;
      expect(() => replacement.sync()).toThrow("replacement denial");
      expect(JSON.parse(readFileSync(manager.stateFile, "utf8"))).toEqual(previous);
      expect(readFileSync(manager.nativeFile, "utf8")).toBe(previous.definition);
      expect(manager.status().enabled).toBe(true);
      expect(manager.authorize(previous.generation)).not.toBeNull();
      expect(calls.slice(start).some(({ args }) => args.includes("delete") || args.includes("disable"))).toBe(false);
    });

    it("rolls back partial installation and reports the native error", () => {
      const { manager, failWhen } = nativeFixture(platform);
      failWhen((binary, args) =>
        (platform === "win32" && binary.endsWith("reg.exe") && args[0] === "add") ||
        (platform === "darwin" && args[0] === "enable") ||
        (platform === "linux" && args[1] === "enable"),
      );
      expect(() => manager.sync()).toThrow(/registration failed.*permission denied/);
      expect(manager.status().enabled).toBe(false);
      expect(existsSync(manager.nativeFile)).toBe(false);
    });

    it("revokes authorization even when native removal fails", () => {
      const { manager, failWhen } = nativeFixture(platform);
      manager.sync();
      const { generation } = JSON.parse(readFileSync(manager.stateFile, "utf8"));
      failWhen((binary, args) =>
        (platform === "win32" && binary.endsWith("reg.exe") && args[0] === "delete") ||
        (platform === "darwin" && args[0] === "disable") ||
        (platform === "linux" && args[1] === "disable"),
      );
      expect(() => manager.remove()).toThrow("permission denied");
      expect(manager.authorize(generation)).toBeNull();
    });
  });

  describe("platform serialization and safety", () => {
    it.each(['{"value":null}', ' \r\n\uFEFF{"value":null}\r\n '])(
      "recognizes an explicitly absent Windows registry value (%j)",
      (stdout) => {
        const { manager, readAs, calls } = nativeFixture("win32");
        readAs({ status: 0, stdout });
        expect(manager.status()).toMatchObject({ installed: false, enabled: false });
        expect(calls.some(({ binary }) => binary.endsWith("reg.exe"))).toBe(false);
      },
    );

    it.each(["", " \r\n ", "null", "{}", "[]", '"string"', '{"value":false}', '{"value":42}',
      '{"value":[]}', '{"value":{}}', '{"value":null,"extra":true}', "{broken}"])(
      "rejects ambiguous or malformed Windows registry output instead of assuming absence (%j)",
      (stdout) => {
        const { manager, readAs, calls } = nativeFixture("win32");
        readAs({ status: 0, stdout });
        expect(() => manager.status()).toThrow("Cannot inspect the current-user Work Board Run entry.");
        expect(calls.some(({ binary }) => binary.endsWith("reg.exe"))).toBe(false);
      },
    );

    it.each(["", "foreign entry \u4e2d\u6587"])("treats a present string as an entry, not absence (%j)", (value) => {
      const { manager, readAs, calls } = nativeFixture("win32");
      readAs({ status: 0, stdout: JSON.stringify({ value }) });
      expect(() => manager.status()).toThrow("Conflicting autostart entry");
      expect(calls.some(({ binary }) => binary.endsWith("reg.exe"))).toBe(false);
    });

    it("accepts an owned string envelope without losing the registration identity", () => {
      const { manager, readAs, calls } = nativeFixture("win32");
      manager.sync();
      const installation = calls.find(({ binary, args }) => binary.endsWith("reg.exe") && args[0] === "add");
      const value = installation.args[installation.args.indexOf("/d") + 1];
      readAs({ status: 0, stdout: JSON.stringify({ value }) });
      const before = calls.length;
      expect(manager.status()).toMatchObject({ installed: true, enabled: true });
      expect(calls.slice(before).some(({ binary }) => binary.endsWith("reg.exe"))).toBe(false);
    });

    it.each([
      { status: 1, stderr: "permission denied" },
      { status: null, error: { code: "ETIMEDOUT" } },
    ])("preserves a native registry-read failure (%j)", (result) => {
      const { manager, readAs } = nativeFixture("win32");
      readAs(result);
      expect(() => manager.status()).toThrow(result.error?.code ?? "permission denied");
    });

    it.runIf(process.platform === "win32").each(["value", "key"])(
      "reads an absent Windows %s using real Windows PowerShell without creating persistence",
      (missing) => {
        const f = nativeFixture("win32");
        let reads = 0;
        const manager = createAutostartManager({
          root: f.manager.root, home: f.home,
          environment: { LOCALAPPDATA: path.join(f.home, "Local") },
          command(binary, args) {
            const script = args.at(-1);
            if (script.includes("WORKBOARD_ACL_CHECK")) return { status: 0, stdout: "trusted" };
            if (!binary.endsWith("powershell.exe") || !script.includes("::CurrentUser.OpenSubKey")) {
              throw new Error("Registry mutation is forbidden in this test.");
            }
            const absent = `workboard-readonly-${randomUUID()}`;
            const readOnlyScript = missing === "value"
              ? script.replace(`GetValue('${f.manager.id}'`, `GetValue('${absent}'`)
              : script.replace("CurrentVersion\\Run'", `CurrentVersion\\Run\\${absent}'`);
            expect(readOnlyScript).not.toBe(script);
            expect(readOnlyScript).toMatch(/finally.*\.Dispose\(\)/);
            const result = spawnSync(binary, [...args.slice(0, -1), readOnlyScript], {
              encoding: "utf8", windowsHide: true, timeout: 15_000,
            });
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({ value: null });
            reads++;
            return result;
          },
        });
        expect(manager.status()).toMatchObject({ installed: false, enabled: false });
        expect(reads).toBe(1);
        expect(existsSync(manager.stateFile)).toBe(false);
        expect(existsSync(manager.nativeFile)).toBe(false);
      }, 30_000,
    );

    it.each([false, true])("does not overwrite an orphaned Windows launcher (owned tombstone: %s)", (tombstone) => {
      const { manager, calls } = nativeFixture("win32");
      if (tombstone) {
        manager.sync();
        manager.remove();
      }
      writePrivateFile(manager.nativeFile, "unknown Windows launcher");
      const start = calls.length;
      expect(() => manager.sync()).toThrow(/outside Work Board|Conflicting|unowned/);
      expect(readFileSync(manager.nativeFile, "utf8")).toBe("unknown Windows launcher");
      expect(calls.slice(start).some(({ binary }) => binary.endsWith("reg.exe"))).toBe(false);
    });

    it("escapes XML and systemd command layers independently", () => {
      expect(xmlString('A&B<"\'')).toBe("A&amp;B&lt;&quot;&apos;");
      expect(systemdArgument('/tmp/a %n $PATH "quoted"\\node'))
        .toBe('"/tmp/a %%n $$PATH \\"quoted\\"\\\\node"');
      expect(() => systemdArgument("line\nbreak")).toThrow("control characters");
    });

    it("keeps Windows paths ASCII-encoded and uses a single percent-expansion layer", () => {
      const script = renderWindowsLauncher({
        root: "C:\\Work\\\u6d4b\u8bd5%PATH% & space", nodePath: "C:\\Program Files\\node.exe",
        script: "C:\\a %PATH%\\background.mjs", generation: "test-generation", log: "C:\\logs\\startup.log",
      });
      expect(script).toContain("\\u6d4b\\u8bd5");
      expect(script).toContain('"%WORKBOARD_LOGIN_NODE%" "%WORKBOARD_LOGIN_SCRIPT%" login');
      expect(script).toContain(", 0, true)");
      expect(script).not.toContain("cmd /");
    });

    it("rejects redirected state directories without touching their targets", () => {
      const root = fixture();
      const other = fixture();
      const link = path.join(root, "redirect");
      symlinkSync(other, link, process.platform === "win32" ? "junction" : "dir");
      expect(() => writePrivateFile(path.join(link, "state"), "unexpected")).toThrow("redirected");
      expect(existsSync(path.join(other, "state"))).toBe(false);
      rmSync(link);
    });

    it("reports a failed systemd state check instead of silently returning disabled", () => {
      const { manager, failWhen } = nativeFixture("linux");
      manager.sync();
      failWhen((_binary, args) => args.includes("is-enabled"));
      expect(() => manager.status()).toThrow("Cannot verify systemd");
    });

    it("refuses Windows persistence when private directory permissions cannot be verified", () => {
      const { manager, failWhen, calls } = nativeFixture("win32");
      failWhen((binary, args) => binary.endsWith("powershell.exe") && args.at(-1).includes("WORKBOARD_ACL_CHECK"));
      expect(() => manager.sync()).toThrow("permission denied");
      expect(calls.some(({ binary }) => binary.endsWith("reg.exe"))).toBe(false);
    });

    it("cleans a blocked WSH preflight without creating registry persistence or authorization", () => {
      const { manager, failWhen, calls } = nativeFixture("win32");
      failWhen((binary) => binary.endsWith("wscript.exe"));
      expect(() => manager.sync()).toThrow("permission denied");
      expect(existsSync(path.join(manager.directory, "preflight.js"))).toBe(false);
      expect(existsSync(manager.stateFile)).toBe(false);
      expect(existsSync(manager.nativeFile)).toBe(false);
      expect(calls.some(({ binary }) => binary.endsWith("reg.exe"))).toBe(false);
    });

    it.each(["percent", "too-long"])("rejects an unsafe Windows Run location (%s) before persistence", (kind) => {
      const { manager, command, home, calls } = nativeFixture("win32");
      const unsafe = createAutostartManager({
        root: manager.root, home, platform: "win32", command,
        environment: { LOCALAPPDATA: path.join(home, kind === "percent" ? "%LITERAL%" : "a".repeat(160)) },
      });
      expect(() => unsafe.sync()).toThrow("260-character Run limit");
      expect(existsSync(unsafe.stateFile)).toBe(false);
      expect(existsSync(unsafe.nativeFile)).toBe(false);
      expect(calls.some(({ binary }) => binary.endsWith("reg.exe") || binary.endsWith("wscript.exe"))).toBe(false);
    });

    const wscript = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
    it.runIf(process.platform === "win32")(
      "checks real Windows ACLs on owned temporary artifacts and rejects public write access without registry changes",
      () => {
        const root = fixture();
        const home = path.join(root, "home");
        const manager = createAutostartManager({
          root, home, environment: { LOCALAPPDATA: path.join(home, "Local") },
          command(binary, args) {
            if (args.at(-1).includes("WORKBOARD_ACL_CHECK")) {
              return spawnSync(binary, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
            }
            if (binary.endsWith("powershell.exe")) return { status: 0, stdout: '{"value":null}' };
            throw new Error("Native registry mutations are forbidden in this test.");
          },
        });
        ensurePrivateDirectory(manager.directory);
        expect(manager.status().installed).toBe(false);
        const result = spawnSync(
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
          [manager.directory, "/grant", "*S-1-1-0:(OI)(CI)(W)"],
          { encoding: "utf8", windowsHide: true, timeout: 15_000 },
        );
        expect(result.status).toBe(0);
        expect(() => manager.status()).toThrow("writable by another principal");
      }, 30_000,
    );

    it.runIf(process.platform === "win32" && existsSync(wscript))(
      "runs the real hidden WSH launcher with literal Unicode/percent/metacharacter paths, without registering anything",
      () => {
        const root = path.join(fixture(), "space & \u6d4b\u8bd5 %WORKBOARD_LITERAL_TEST% $");
        const probe = path.join(root, "argv-probe.mjs");
        writePrivateFile(probe, `import { writeFileSync } from "node:fs";
  writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
  `);
        const launcher = path.join(root, "launcher.js");
        const log = path.join(root, "bootstrap.log");
        writePrivateFile(launcher, renderWindowsLauncher({
          root, nodePath: process.execPath, script: probe, generation: "literal-generation", log,
        }));
        const result = spawnSync(wscript, ["//B", "//E:JScript", "//Nologo", launcher], {
          windowsHide: true, timeout: 15_000,
          env: { ...process.env, WORKBOARD_LITERAL_TEST: "MUST-NOT-REPLACE-LITERAL-PATH" },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, existsSync(log) ? readFileSync(log, "utf8") : "WSH exited").toBe(0);
        expect(JSON.parse(readFileSync(path.join(root, "argv.json"), "utf8"))).toEqual({
          argv: ["login", "literal-generation"], cwd: root,
        });
        expect(existsSync(log)).toBe(false);
      }, 20_000,
    );

    it.runIf(process.platform === "win32" && existsSync(wscript))(
      "records native pre-Node failures in the persistent bootstrap diagnostic path",
      () => {
        const root = fixture();
        const launcher = path.join(root, "launcher.js");
        const log = path.join(root, "bootstrap.log");
        writePrivateFile(launcher, renderWindowsLauncher({
          root, nodePath: path.join(root, "missing-node.exe"),
          script: path.join(root, "missing.mjs"), generation: "failure-generation", log,
        }));
        const result = spawnSync(wscript, ["//B", "//E:JScript", "//Nologo", launcher], {
          windowsHide: true, timeout: 15_000,
        });
        expect(result.status).toBe(1);
        expect(readFileSync(log, "utf8").trim()).not.toBe("");
      }, 20_000,
    );
  });

  it("accepts only positive bounded numeric process IDs", () => {
    expect(isPositivePid(123)).toBe(true);
  });

  it("atomically replaces private ordinary files", () => {
    const file = path.join(fixture(), "owned", "state.json");
    writePrivateFile(file, '{"version":1}');
    writePrivateFile(file, '{"version":2}');
    expect(readFileSync(file, "utf8")).toBe('{"version":2}');
  });

  it("serializes concurrent commands and releases its lock", async () => {
    const root = fixture();
    const sequence = [];
    await Promise.all([
      withLifecycleLock(root, async () => {
        sequence.push("first-enter");
        await new Promise((resolve) => setTimeout(resolve, 60));
        sequence.push("first-exit");
      }),
      withLifecycleLock(root, () => sequence.push("second-enter")),
    ]);
    expect(sequence).toEqual(["first-enter", "first-exit", "second-enter"]);
    expect(existsSync(path.join(root, "data", "codeboard.lifecycle.lock"))).toBe(false);
  });

  it("recovers a dead command's stale lock without signalling it", async () => {
    const root = fixture();
    const file = path.join(root, "data", "codeboard.lifecycle.lock");
    writePrivateFile(file, JSON.stringify({ pid: 123, token: "dead-command" }));
    await expect(
      withLifecycleLock(root, () => "recovered", { isAlive: () => false }),
    ).resolves.toBe("recovered");
    expect(existsSync(file)).toBe(false);
  });

  it("never steals a live command or removes its lock", async () => {
    const root = fixture();
    const file = path.join(root, "data", "codeboard.lifecycle.lock");
    const content = JSON.stringify({ pid: 123, token: "live-command" });
    writePrivateFile(file, content);
    await expect(
      withLifecycleLock(root, () => {}, { timeoutMs: 0, isAlive: () => true }),
    ).rejects.toThrow("Another background command");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("old cleanup preserves a replacement lock and fences further mutations", async () => {
    const root = fixture();
    const file = path.join(root, "data", "codeboard.lifecycle.lock");
    await withLifecycleLock(root, (assertOwner) => {
      writeFileSync(file, "replacement-owner");
      expect(assertOwner).toThrow("ownership changed");
    });
    expect(readFileSync(file, "utf8")).toBe("replacement-owner");
  });
});
