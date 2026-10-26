import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface TestIdentity {
  appId: string;
  directory: string;
  shortcut: string;
}
const root = process.cwd();
const identities: TestIdentity[] = [];
const enabled = process.platform === "win32" && process.env.WORKBOARD_NATIVE_NOTIFICATION_TEST === "1";

function native(action: "Prepare" | "Inspect" | "Remove", appId: string, overrides: Record<string, unknown> = {}) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = execFile(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts", "workboard-notify.ps1"), "-Action", action,
    ], {
      encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
      env: {
        NODE_ENV: process.env.NODE_ENV, SystemRoot: systemRoot, windir: systemRoot,
        USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
        TEMP: process.env.TEMP, TMP: process.env.TMP,
        PATH: `${path.join(systemRoot, "System32")};${path.dirname(executable)}`,
      },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else {
        try { resolve(JSON.parse(stdout.trim())); }
        catch (reason) { reject(reason); }
      }
    });
    child.stdin?.end(JSON.stringify({
      appId, root, title: "Synthetic test", message: "No notification is displayed",
      details: "Preparation only", url: "http://127.0.0.1:1/work/synthetic", ...overrides,
    }));
  });
}

async function identity(): Promise<TestIdentity> {
  const appId = `WorkBoard.Test.${randomBytes(8).toString("hex")}`;
  const state = await native("Inspect", appId);
  if (typeof state.directory !== "string" || typeof state.shortcut !== "string" || state.installed !== false) {
    throw new Error("Expected an unregistered isolated test identity.");
  }
  const result = { appId, directory: state.directory, shortcut: state.shortcut };
  identities.push(result);
  return result;
}

afterEach(async () => {
  for (const fixture of identities.splice(0)) {
    await native("Remove", fixture.appId);
    expect((await native("Inspect", fixture.appId)).installed).toBe(false);
    const parent = path.dirname(fixture.shortcut);
    try {
      if ((await readdir(parent)).length === 0) await rmdir(parent);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
});

// Opt-in tests touch only random WorkBoard.Test identities, never display toasts.
describe.runIf(enabled)("native notification preparation and ownership", () => {
  it("prepares concurrently once and preserves XML/Unicode without executable interpolation", async () => {
    const fixture = await identity();
    const payload = { title: 'Work <completed> & "ready"', message: "中文 👩‍💻 & <work>", details: "2m · 2M tokens" };
    const results = await Promise.all([native("Prepare", fixture.appId, payload), native("Prepare", fixture.appId, payload)]);
    for (const result of results) {
      expect(result.prepared).toBe(true);
      expect(result.xml).toContain('activationType="protocol"');
      expect(result.xml).toContain("&lt;completed&gt;");
      expect(result.xml).toContain("&amp;");
      expect(result.xml).toContain("中文 👩‍💻");
      expect(result.xml).toContain("2m · 2M tokens");
    }
    const stateFile = path.join(fixture.directory, "owner.json");
    const before = await readFile(stateFile, "utf8");
    expect((await native("Inspect", fixture.appId)).installed).toBe(true);
    await native("Prepare", fixture.appId, payload);
    expect(await readFile(stateFile, "utf8")).toBe(before);
  }, 45_000);

  it("refuses an orphaned shortcut without modifying it", async () => {
    const fixture = await identity();
    await mkdir(path.dirname(fixture.shortcut), { recursive: true });
    await writeFile(fixture.shortcut, "Synthetic foreign shortcut fixture", { flag: "wx" });
    try {
      await expect(native("Prepare", fixture.appId)).rejects.toThrow("shortcut is unowned");
      expect(await readFile(fixture.shortcut, "utf8")).toBe("Synthetic foreign shortcut fixture");
    } finally {
      await unlink(fixture.shortcut);
    }
  }, 30_000);

  it("refuses changed metadata and leaves it intact", async () => {
    const fixture = await identity();
    await native("Prepare", fixture.appId);
    const file = path.join(fixture.directory, "owner.json");
    const original = await readFile(file, "utf8");
    const changed = JSON.stringify({ ...JSON.parse(original), root: "C:\\Synthetic-Foreign-Root" });
    await writeFile(file, changed);
    try {
      await expect(native("Prepare", fixture.appId)).rejects.toThrow("another installation");
      expect(await readFile(file, "utf8")).toBe(changed);
    } finally {
      await writeFile(file, original);
    }
  }, 30_000);

  it("preserves existing metadata and registration when repair cannot replace a read-only file", async () => {
    const fixture = await identity();
    await native("Prepare", fixture.appId);
    const file = path.join(fixture.directory, "owner.json");
    const before = await readFile(file, "utf8");
    await unlink(fixture.shortcut);
    await chmod(file, 0o444);
    try {
      await expect(native("Prepare", fixture.appId)).rejects.toThrow("Windows notification operation failed");
      expect(await readFile(file, "utf8")).toBe(before);
      expect((await native("Inspect", fixture.appId)).installed).toBe(false);
      await expect(readFile(fixture.shortcut)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(file, 0o600);
    }
    await native("Prepare", fixture.appId);
    expect((await native("Inspect", fixture.appId)).installed).toBe(true);
  }, 45_000);
});
