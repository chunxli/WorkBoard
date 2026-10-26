#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";

export function resolveAutostartEnabled(environment) {
  const value = environment.WORKBOARD_AUTOSTART?.trim().toLowerCase() ?? "";
  if (!value || value === "true") return true;
  if (value === "false") return false;
  throw new Error("WORKBOARD_AUTOSTART must be true or false.");
}

export function readOptionalText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read ${file}: ${error.code ?? "read failed"}.`);
  }
}

export function loadRuntimeEnvironment(root, inherited = process.env) {
  const text = readOptionalText(path.join(root, ".env"));
  const configured = text === null ? {} : parse(text);
  const environment = { ...configured, ...inherited };
  // A newly disabled checkout must override an old login-manager environment.
  if (Object.hasOwn(configured, "WORKBOARD_AUTOSTART")) {
    environment.WORKBOARD_AUTOSTART = configured.WORKBOARD_AUTOSTART;
  }
  return environment;
}

export function assertSafePath(file) {
  let current = path.resolve(file);
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing redirected startup/state path: ${current}.`);
      }
      if (process.platform !== "win32") {
        if (stat.uid !== process.getuid() && stat.uid !== 0) {
          throw new Error(`Startup/state path has a different owner: ${current}.`);
        }
        if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
          throw new Error(`Startup/state path is writable by other users: ${current}.`);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function ensurePrivateDirectory(directory) {
  assertSafePath(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafePath(directory);
}

export function writePrivateFile(file, content) {
  ensurePrivateDirectory(path.dirname(file));
  assertSafePath(file);
  if (existsSync(file) && !lstatSync(file).isFile()) {
    throw new Error(`Expected an ordinary owned file: ${file}.`);
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content);
    closeSync(descriptor);
    descriptor = undefined;
    assertSafePath(file);
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function isPositivePid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647;
}

export function isProcessAlive(pid) {
  if (!isPositivePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export async function withLifecycleLock(root, callback, options = {}) {
  const directory = path.join(root, "data");
  ensurePrivateDirectory(directory);
  const file = path.join(directory, "codeboard.lifecycle.lock");
  const token = randomUUID();
  const record = JSON.stringify({ pid: process.pid, token });
  const timeout = options.timeoutMs ?? 120_000;
  const alive = options.isAlive ?? isProcessAlive;
  const began = Date.now();
  for (;;) {
    assertSafePath(file);
    try {
      const descriptor = openSync(file, "wx", 0o600);
      try {
        writeFileSync(descriptor, record);
      } finally {
        closeSync(descriptor);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const previous = readOptionalText(file);
    let owner;
    try {
      owner = previous === null ? null : JSON.parse(previous);
    } catch {
      owner = null;
    }
    if (
      owner &&
      isPositivePid(owner.pid) &&
      typeof owner.token === "string" &&
      !alive(owner.pid) &&
      readOptionalText(file) === previous
    ) {
      rmSync(file);
      continue;
    }
    if (Date.now() - began >= timeout) {
      throw new Error(
        `Another background command holds ${file}. If its owner is no longer running, remove this stale lock and retry.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const assertOwner = () => {
    if (readOptionalText(file) !== record) {
      throw new Error("Background lifecycle ownership changed; refusing to continue.");
    }
  };
  try {
    assertOwner();
    return await callback(assertOwner);
  } finally {
    if (readOptionalText(file) === record) rmSync(file);
  }
}

function checkedPath(value) {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Autostart paths must not contain control characters.");
  }
  return value;
}

function jsString(value) {
  return JSON.stringify(checkedPath(value)).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function xmlString(value) {
  return checkedPath(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

export function systemdArgument(value, expandVariables = true) {
  let escaped = checkedPath(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  if (expandVariables) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

export function renderWindowsLauncher({ root, nodePath, script, generation, log }) {
  return [
    "var shell = new ActiveXObject('WScript.Shell');",
    "var filesystem = new ActiveXObject('Scripting.FileSystemObject');",
    "try {",
    `  shell.CurrentDirectory = ${jsString(root)};`,
    "  var environment = shell.Environment('Process');",
    `  environment('WORKBOARD_LOGIN_NODE') = ${jsString(nodePath)};`,
    `  environment('WORKBOARD_LOGIN_SCRIPT') = ${jsString(script)};`,
    // WSH expands percent variables once, after reading these literal values.
    `  var code = shell.Run('"%WORKBOARD_LOGIN_NODE%" "%WORKBOARD_LOGIN_SCRIPT%" login ${generation}', 0, true);`,
    "  if (code !== 0) throw new Error('Work Board login startup exited with code ' + code);",
    "} catch (error) {",
    `  var output = filesystem.OpenTextFile(${jsString(log)}, 8, true);`,
    "  output.WriteLine(new Date().toUTCString() + ' ' + error.message);",
    "  output.Close();",
    "  WScript.Quit(1);",
    "}",
    "",
  ].join("\n");
}

export function renderLaunchAgent({ label, nodePath, script, generation, root, searchPath, log }) {
  const args = [nodePath, script, "login", generation]
    .map((value) => `      <string>${xmlString(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xmlString(label)}</string>
    <key>ProgramArguments</key><array>
${args}
    </array>
    <key>WorkingDirectory</key><string>${xmlString(root)}</string>
    <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlString(searchPath)}</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
    <key>StandardOutPath</key><string>${xmlString(log)}</string>
    <key>StandardErrorPath</key><string>${xmlString(log)}</string>
  </dict>
</plist>
`;
}

export function renderUserService({ nodePath, script, generation, root, searchPath }) {
  return `[Unit]
Description=Work Board login startup

[Service]
Type=exec
WorkingDirectory=${systemdArgument(root, false)}
ExecStart=${[nodePath, script, "login", generation].map((argument) => systemdArgument(argument)).join(" ")}
Environment=${systemdArgument(`PATH=${searchPath}`, false)}
Restart=no
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

function runCommand(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
}

export function createAutostartManager(options = {}) {
  const root = realpathSync(options.root ?? path.resolve(import.meta.dirname, ".."));
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.home ?? os.homedir();
  const nodePath = options.nodePath ?? realpathSync(process.execPath);
  const command = options.command ?? runCommand;
  const uid = options.uid ?? process.getuid?.();
  const owner = platform === "win32" ? os.userInfo().username : `uid:${uid}`;
  const digest = createHash("sha256")
    .update(platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 12);
  const id = `workboard-${digest}`;
  const label = `com.workboard.${digest}`;
  const supported = ["win32", "darwin", "linux"].includes(platform);
  const base = platform === "win32"
    ? path.join(environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "WorkBoard", "autostart")
    : platform === "darwin"
      ? path.join(home, "Library", "Application Support", "WorkBoard", "autostart")
      : path.join(environment.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "workboard", "autostart");
  const directory = path.join(base, id);
  const stateFile = path.join(directory, "registration.json");
  const log = path.join(directory, "bootstrap.log");
  const script = path.join(root, "scripts", "codeboard-background.mjs");
  const nativeFile = platform === "win32" ? path.join(directory, "launch.js")
    : platform === "darwin" ? path.join(home, "Library", "LaunchAgents", `${label}.plist`)
      : path.join(environment.XDG_CONFIG_HOME ?? path.join(home, ".config"), "systemd", "user", `${id}.service`);
  const windowsDirectory = environment.SystemRoot ?? "C:\\Windows";
  const executable = (name) => path.join(windowsDirectory, "System32", name);
  const registryKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const registryCommand = `"${executable("wscript.exe")}" //B //E:JScript //Nologo "${nativeFile}"`;

  function native(binary, args, accepted = [0]) {
    const result = command(binary, args);
    if (result.error || !accepted.includes(result.status)) {
      throw new Error(
        `Autostart ${path.basename(binary)} failed (${result.error?.code ?? result.status ?? "no exit status"}): ${(result.stderr ?? "").trim() || "check current-user permissions and platform support"}`,
      );
    }
    return result.stdout?.trim() ?? "";
  }

  function requireSupported() {
    if (!supported) throw new Error(`Login autostart is not supported on ${platform}.`);
    checkedPath(root);
    checkedPath(nodePath);
  }

  function checkWindowsPermissions() {
    if (platform !== "win32") return;
    const literal = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop'; try {
      # WORKBOARD_ACL_CHECK: only current-user and privileged Windows principals may write startup artifacts.
      $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544');
      $mask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership;
      function Assert-PrivateAcl($acl) {
          if($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'Startup directory has a different owner'};
          foreach($rule in $acl.Access) {
            if($rule.AccessControlType -eq 'Allow' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($rule.FileSystemRights -band $mask) -ne 0) {
              if($allowed -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value){throw 'Startup directory is writable by another principal'};
            }
          }
      }
      $current=${literal(directory)}; $homePath=${literal(path.resolve(home))};
      while($current) {
        if([IO.Directory]::Exists($current)){Assert-PrivateAcl ([IO.Directory]::GetAccessControl($current))};
        if($current -eq $homePath){break};
        $parent=[IO.Path]::GetDirectoryName($current);
        if($parent -eq $current){break}; $current=$parent;
      }
      foreach($file in @(${literal(stateFile)},${literal(nativeFile)})) {
        if([IO.File]::Exists($file)){Assert-PrivateAcl ([IO.File]::GetAccessControl($file))};
      }
      'trusted'
    } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    const result = native(executable("WindowsPowerShell\\v1.0\\powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
    ]);
    if (result !== "trusted") throw new Error("Cannot verify private Windows startup-directory permissions.");
  }

  function readRegistration() {
    assertSafePath(stateFile);
    checkWindowsPermissions();
    const text = readOptionalText(stateFile);
    if (text === null) return null;
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw new Error(`Invalid autostart metadata: ${stateFile}.`);
    }
    if (state.version !== 1 || state.root !== root || state.id !== id || state.owner !== owner ||
      !/^[a-f0-9-]{36}$/.test(state.generation) ||
      typeof state.definition !== "string" || !Array.isArray(state.pathEntries) ||
      state.pathEntries.some((entry) => typeof entry !== "string" || /[\r\n\0]/.test(entry))) {
      throw new Error(`Autostart metadata belongs to another installation or is invalid: ${stateFile}.`);
    }
    return state;
  }

  function saveRegistration(state) {
    writePrivateFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  function readNative() {
    requireSupported();
    if (platform !== "win32") {
      assertSafePath(nativeFile);
      return readOptionalText(nativeFile);
    }
    const readScript = `$ErrorActionPreference='Stop'; $key=$null; try { $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run'); $value=if($null -eq $key){$null}else{$key.GetValue('${id}',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}; ConvertTo-Json -InputObject @{value=$value} -Compress } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 } finally { if($null -ne $key){$key.Dispose()} }`;
    const output = native(executable("WindowsPowerShell\\v1.0\\powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", readScript,
    ]);
    try {
      const result = JSON.parse(output.replace(/^\uFEFF/, ""));
      if (result === null || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).length !== 1 || !Object.hasOwn(result, "value") ||
        result.value !== null && typeof result.value !== "string") throw new Error();
      return result.value;
    } catch {
      throw new Error("Cannot inspect the current-user Work Board Run entry.");
    }
  }

  function enabledNative() {
    if (platform === "linux") {
      const value = native("/usr/bin/systemctl", ["--user", "is-enabled", `${id}.service`], [0, 1]);
      if (!["enabled", "disabled", "masked", "static", "indirect", "generated", "linked", "alias"].includes(value)) {
        throw new Error("Cannot verify systemd user-service enablement; inspect systemctl --user and its permissions.");
      }
      return value === "enabled";
    }
    if (platform === "darwin") {
      const disabled = native("/bin/launchctl", ["print-disabled", `gui/${uid}`]);
      return !new RegExp(`"${label.replaceAll(".", "\\.")}"\\s*=>\\s*true`).test(disabled);
    }
    return true;
  }

  function status() {
    requireSupported();
    const state = readRegistration();
    const actual = readNative();
    if (actual !== null && (!state || actual !== (platform === "win32" ? registryCommand : state.definition))) {
      throw new Error(`Conflicting autostart entry; refusing to overwrite/remove it: ${nativeFile}.`);
    }
    if (platform === "win32") {
      assertSafePath(nativeFile);
      const launcher = readOptionalText(nativeFile);
      if ((launcher !== null && (!state || launcher !== state.definition)) ||
        (actual !== null && launcher === null)) {
        throw new Error(`Autostart launcher was changed outside Work Board: ${nativeFile}.`);
      }
    }
    const installed = actual !== null;
    const enabled = installed && enabledNative();
    return {
      supported, installed, nativeEnabled: enabled, enabled: Boolean(state?.enabled && enabled),
      root, id, nativeFile, stateFile, log,
      note: platform === "linux"
        ? "User-manager startup normally follows login; existing linger can start it at boot. Linger is not changed."
        : platform === "darwin" ? "LaunchAgents run in the user's GUI login session and end at logout."
          : "Current-user login startup requires Windows Script Host; Windows may delay login items.",
    };
  }

  function writeNative(state, enable = true) {
    writePrivateFile(nativeFile, state.definition);
    if (platform === "win32") {
      native(executable("reg.exe"), ["add", registryKey, "/v", id, "/t", "REG_SZ", "/d", registryCommand, "/f"]);
    } else if (platform === "darwin") {
      native("/bin/launchctl", [enable ? "enable" : "disable", `gui/${uid}/${label}`]);
    } else {
      native("/usr/bin/systemctl", ["--user", "daemon-reload"]);
      native("/usr/bin/systemctl", ["--user", enable ? "enable" : "disable", `${id}.service`]);
    }
  }

  function removeNative(state) {
    const actual = readNative();
    if (actual !== null && actual !== (platform === "win32" ? registryCommand : state.definition)) {
      throw new Error("Autostart entry changed during cleanup; leaving it untouched.");
    }
    assertSafePath(nativeFile);
    const previousFile = readOptionalText(nativeFile);
    if (previousFile !== null && previousFile !== state.definition) {
      throw new Error(`Startup file changed; leaving it untouched: ${nativeFile}.`);
    }
    if (actual !== null) {
      if (platform === "win32") {
        native(executable("reg.exe"), ["delete", registryKey, "/v", id, "/f"]);
      } else if (platform === "darwin") {
        native("/bin/launchctl", ["disable", `gui/${uid}/${label}`]);
      } else {
        native("/usr/bin/systemctl", ["--user", "disable", `${id}.service`]);
      }
    }
    assertSafePath(nativeFile);
    const fileContent = readOptionalText(nativeFile);
    if (fileContent !== null) {
      assertSafePath(nativeFile);
      if (fileContent !== state.definition) {
        throw new Error(`Startup file changed; leaving it untouched: ${nativeFile}.`);
      }
      rmSync(nativeFile);
    }
    if (platform === "linux" && actual !== null) {
      native("/usr/bin/systemctl", ["--user", "daemon-reload"]);
    }
    if (readNative() !== null) throw new Error("Autostart removal could not be verified.");
  }

  function remove() {
    const before = status();
    const state = readRegistration();
    if (!state) return before;
    // Revoke queued login launches before removing any native persistence.
    saveRegistration({ ...state, enabled: false });
    removeNative(state);
    return status();
  }

  function sync(runtimeEnvironment = loadRuntimeEnvironment(root, environment)) {
    const enabled = resolveAutostartEnabled(runtimeEnvironment);
    if (!enabled) return remove();
    const before = status();
    const previous = readRegistration();
    if (before.enabled && previous.nodePath === nodePath) return before;
    const previousDefinition = readOptionalText(nativeFile);
    ensurePrivateDirectory(directory);
    if (platform === "win32") {
      if (registryCommand.length > 260 || nativeFile.includes("%")) {
        throw new Error("Windows startup launcher path must fit the 260-character Run limit and contain no percent signs.");
      }
      const probe = path.join(directory, "preflight.js");
      writePrivateFile(probe, "WScript.Quit(42);\n");
      try {
        native(executable("wscript.exe"), ["//B", "//E:JScript", "//Nologo", probe], [42]);
      } finally {
        rmSync(probe, { force: true });
      }
    }
    const delimiter = platform === "win32" ? ";" : ":";
    const paths = platform === "win32" ? path.win32 : path.posix;
    const pathEntries = [...new Set([
      paths.dirname(nodePath),
      ...(runtimeEnvironment.PATH ?? runtimeEnvironment.Path ?? "").split(delimiter),
    ].filter((entry) => paths.isAbsolute(entry) && !/[\r\n\0]/.test(entry)))];
    const generation = randomUUID();
    const fields = { root, nodePath, script, generation, label, searchPath: pathEntries.join(delimiter), log };
    const definition = platform === "win32" ? renderWindowsLauncher(fields)
      : platform === "darwin" ? renderLaunchAgent(fields) : renderUserService(fields);
    const state = { version: 1, id, owner, root, nodePath, generation, enabled: false, pathEntries, definition };
    saveRegistration(state);
    try {
      writeNative(state);
      saveRegistration({ ...state, enabled: true });
      const after = status();
      if (!after.enabled) throw new Error("Autostart registration is present but not enabled.");
      return after;
    } catch (error) {
      const failures = [error];
      try {
        const originalNative = before.installed
          ? platform === "win32" ? registryCommand : previousDefinition : null;
        const unchanged = previous &&
          readOptionalText(nativeFile) === previousDefinition &&
          readNative() === originalNative &&
          (!before.installed || enabledNative() === before.nativeEnabled);
        if (unchanged) {
          // An atomic replacement can fail before touching the previous launcher.
          saveRegistration(previous);
        } else {
          removeNative(state);
          if (previous) {
            saveRegistration(previous);
            if (before.installed) writeNative(previous, before.nativeEnabled);
          } else {
            saveRegistration({ ...state, enabled: false });
          }
        }
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      throw new Error(`Autostart registration failed: ${failures.map((failure) => failure.message).join("; cleanup: ")}`);
    }
  }

  function authorize(generation) {
    const state = readRegistration();
    if (!state?.enabled || state.generation !== generation || !status().enabled) return null;
    return state;
  }

  return { root, id, directory, stateFile, nativeFile, log, status, sync, remove, authorize };
}

async function main() {
  const manager = createAutostartManager();
  const action = process.argv[2];
  if (!["status", "sync", "remove"].includes(action)) {
    throw new Error("Usage: node scripts/autostart.mjs <status|sync|remove>");
  }
  const result = action === "status" ? manager.status()
    : await withLifecycleLock(manager.root, () => manager[action]());
  console.log(`Autostart registration: ${result.enabled ? "enabled" : result.installed ? "disabled" : "absent"}`);
  console.log(`Checkout: ${result.root}\nEntry: ${result.nativeFile}\nBootstrap log: ${result.log}\n${result.note}`);
  try {
    const enabled = resolveAutostartEnabled(loadRuntimeEnvironment(manager.root));
    console.log(`Configured intent: ${enabled ? "enabled" : "disabled"}`);
    if (action === "status" && enabled !== result.enabled) {
      console.log("Intent and registration differ. Use background:start or autostart:sync to reconcile.");
    }
  } catch (error) {
    console.error(`Configuration error (owned cleanup remains available): ${error.message}`);
    process.exitCode = 1;
  }
  console.log("Application running state: inspect separately with npm run background:status.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[Work Board] ${error.message}`);
    process.exitCode = 1;
  });
}
