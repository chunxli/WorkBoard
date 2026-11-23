import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute }),
}));
vi.mock("@/lib/copilot-cli-executable", () => ({ resolveCopilotCliExecutable: () => process.execPath }));
import { getCaseIqInstallation, getCaseIqInstallationPaths } from "./caseiq-installation";

const help = "--interactive --session-id --resume --plugin-dir --additional-mcp-config --allow-tool --disable-mcp-server --secret-env-vars --no-auto-update";
let root: string;
let revision: string;
let branch: string;
let dirty: string;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-observed-version-"));
  await Promise.all(["runtime", "telemetry", path.join("support-packs", "platform")].map((name) =>
    mkdir(path.join(root, name), { recursive: true })));
  await writeFile(path.join(root, "caseiq.ps1"), "# Synthetic current launcher\n");
  await writeFile(path.join(root, "support-packs", "platform", "pack.yaml"), "metadata:\n  id: platform\n  name: Platform\n");
  revision = "c".repeat(40); branch = "feature/current-version"; dirty = " M caseiq.ps1";
  vi.stubEnv("WORKBOARD_CASEIQ_ROOT", root);
  vi.stubEnv("WORKBOARD_CASEIQ_LAUNCHER_SHA256", "a".repeat(64));
  vi.stubEnv("WORKBOARD_CASEIQ_COMMIT", "b".repeat(40));
  vi.stubEnv("WORKBOARD_CASEIQ_CLI_VERSION", "1.0.105");
  mocks.execute.mockImplementation(async (executable: string, args: string[]) => {
    let stdout: string;
    if (executable === "where.exe") stdout = `${process.execPath}\r\n`;
    else if (executable === "git" && args.includes("ls-tree")) stdout = "support-packs/platform/pack.yaml\0";
    else if (executable === "git" && args.includes("rev-parse")) stdout = revision;
    else if (executable === "git" && args.includes("branch")) stdout = branch;
    else if (executable === "git" && args.includes("status")) stdout = dirty;
    else if (executable === process.execPath && args.includes("--version")) stdout = "GitHub Copilot CLI 2.0.0.";
    else if (executable === process.execPath && args.includes("--help")) stdout = help;
    else throw new Error("Unexpected installation probe.");
    return { stdout, stderr: "" };
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe.runIf(process.platform === "win32")("non-blocking CaseIQ source version observations", () => {
  it("resolves metadata ownership paths without repeatedly starting Git or CLI processes", async () => {
    expect(await getCaseIqInstallationPaths()).toEqual({
      launcherPath: path.join(root, "caseiq.ps1"), nativeExecutable: process.execPath,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("accepts updated, non-main and modified sources despite old host pins without editing them", async () => {
    const launcher = await readFile(path.join(root, "caseiq.ps1"), "utf8");
    expect(await getCaseIqInstallation()).toMatchObject({
      sourceCommit: revision, sourceBranch: branch, sourceDirty: true, nativeVersion: "2.0.0",
      launcherSha256: createHash("sha256").update(launcher).digest("hex"),
    });
    expect(await readFile(path.join(root, "caseiq.ps1"), "utf8")).toBe(launcher);
    const mutating = new Set(["pull", "checkout", "reset", "switch"]);
    expect(mocks.execute.mock.calls.flatMap((call) => call[1]).filter((argument) => mutating.has(argument))).toEqual([]);
  });
  it("records the next observed commit/hash independently instead of caching an old version", async () => {
    const first = await getCaseIqInstallation();
    revision = "d".repeat(40);
    await writeFile(path.join(root, "caseiq.ps1"), "# Synthetic next launcher\n");
    const next = await getCaseIqInstallation();
    expect(next.sourceCommit).toBe(revision);
    expect(next.launcherSha256).not.toBe(first.launcherSha256);
  });
  it("records a detached clean checkout instead of requiring a named main branch", async () => {
    branch = ""; dirty = "";
    expect(await getCaseIqInstallation()).toMatchObject({ sourceCommit: revision, sourceBranch: null, sourceDirty: false });
  });
});
