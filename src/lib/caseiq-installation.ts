import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolveCopilotCliExecutable } from "@/lib/copilot-cli-executable";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { CASEIQ_WEB_LIMITATION, type CaseIqStatus } from "@/lib/caseiq-options";
import { getCaseIqStateRoot } from "@/lib/native-runtime-paths";
import { nativeBindingCompatibilityKey, type NativeInstallationIdentity } from "@/lib/native-session-identity";

const executeFile = promisify(execFile);
const registrationSchema = z.object({
  root: z.string().min(1),
  launcherSha256: z.unknown().optional(),
  sourceCommit: z.unknown().optional(),
  nativeVersion: z.unknown().optional(),
}).strict().transform(({ root }) => ({ root }));

export type CaseIqRegistration = z.infer<typeof registrationSchema>;

class CaseIqRegistrationError extends CaseIqIntegrationError {
  constructor(message: string, readonly configured: boolean, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CaseIqInstallation extends NativeInstallationIdentity {
  root: string;
  sourceBranch?: string | null;
  sourceDirty?: boolean;
  packs: { id: string; name: string }[];
}

export function assertCaseIqCheckout(commit: string): void {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new CaseIqIntegrationError("The CaseIQ source revision could not be recorded. Check read access to its Git metadata; WorkBoard does not modify that repository.");
  }
}

export function verifyCaseIqCli(versionText: string, helpText: string): string {
  const version = /GitHub Copilot CLI (\d+)\.(\d+)\.(\d+)/.exec(versionText);
  const required = ["--interactive", "--session-id", "--resume", "--plugin-dir", "--additional-mcp-config",
    "--allow-tool", "--disable-mcp-server", "--secret-env-vars", "--no-auto-update"];
  if (!version || required.some((flag) => !helpText.includes(flag))) {
    throw new CaseIqIntegrationError("The installed Copilot CLI lacks a verified CaseIQ prompt/resume interface. Revalidate CLI compatibility before starting a Run.");
  }
  return `${version[1]}.${version[2]}.${version[3]}`;
}

export async function readOptionalCaseIqText(file: string): Promise<string | null> {
  try { return await readFile(/* turbopackIgnore: true */ file, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readCaseIqRegistration(): Promise<CaseIqRegistration> {
  const root = process.env.WORKBOARD_CASEIQ_ROOT?.trim();
  let value: unknown;
  if (root) {
    value = { root };
  } else {
    let content: string | null;
    try {
      content = await readOptionalCaseIqText(path.join(/* turbopackIgnore: true */ process.cwd(), "data", "caseiq", "installation.json"));
    } catch (error) {
      throw new CaseIqRegistrationError("CaseIQ host registration could not be read. Check host configuration and server logs.", true, error);
    }
    if (content === null) {
      throw new CaseIqRegistrationError("Configure the trusted CaseIQ installation on this WorkBoard host. See CaseIQ integration docs.", false);
    }
    try { value = JSON.parse(content.replace(/^\uFEFF/, "")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new CaseIqRegistrationError("CaseIQ host registration contains invalid JSON. Correct it outside WorkBoard before retrying.", true);
    }
  }
  const registration = registrationSchema.safeParse(value);
  if (!registration.success) {
    throw new CaseIqRegistrationError("CaseIQ host registration is invalid. Check its installation root and supported fields; see the integration guide.", true);
  }
  if (!path.isAbsolute(registration.data.root) || registration.data.root.includes("\0")) {
    throw new CaseIqRegistrationError("The configured CaseIQ root must be an absolute path without null characters.", true);
  }
  return registration.data;
}

async function command(name: string): Promise<string | null> {
  try {
    const result = await executeFile("where.exe", [name], { windowsHide: true, timeout: 10_000 });
    return result.stdout.trim().split(/\r?\n/)[0] || null;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === 1 || error.code === "ENOENT")) return null;
    throw error;
  }
}

export async function getCaseIqPromptPowerShell(): Promise<string> {
  if (process.platform !== "win32") {
    throw new CaseIqIntegrationError("CaseIQ integration requires a Windows execution host.");
  }
  const executable = await command("pwsh.exe");
  if (!executable) {
    throw new CaseIqIntegrationError("PowerShell 7 (pwsh.exe) is required for CaseIQ web execution. Prepare it on the host; Windows PowerShell 5.1 cannot reliably read CaseIQ's generated long paths.");
  }
  let version: string;
  try {
    const result = await executeFile(executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()",
    ], { windowsHide: true, timeout: 10_000 });
    version = result.stdout.trim();
  } catch (error) {
    console.error("[CaseIQ] PowerShell host verification failed.", error);
    throw new CaseIqIntegrationError("The CaseIQ PowerShell host could not be verified. Check the host installation and server diagnostics.");
  }
  const match = /^(\d+)\.\d+\.\d+(?:[-+][a-z0-9._-]+)?$/i.exec(version);
  if (!match || Number(match[1]) < 7) {
    throw new CaseIqIntegrationError("CaseIQ web execution requires PowerShell 7 or newer; the resolved host is incompatible.");
  }
  return executable;
}

async function requirePlainCaseIqDirectory(directory: string): Promise<void> {
  const entry = await lstat(/* turbopackIgnore: true */ directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new CaseIqIntegrationError("CaseIQ plugin and support-pack directories must be regular directories, not symbolic links or junctions. Revalidate the installation outside WorkBoard.");
  }
}

let committedPackIndex: { key: string; ids: Promise<readonly string[]> } | null = null;

async function committedPackIds(root: string, sourceCommit: string): Promise<readonly string[]> {
  const resolvedRoot = path.resolve(root);
  const key = `${process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot}\0${sourceCommit}`;
  let entry = committedPackIndex;
  if (!entry || entry.key !== key) {
    const ids = executeFile("git", ["-C", root, "--no-pager", "ls-tree", "-r", "-z", "--name-only", sourceCommit, "--", "support-packs"], {
      windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    }).then(({ stdout }) => Object.freeze(stdout.split("\0").flatMap((file) => {
      const match = /^support-packs\/([a-z0-9][a-z0-9._-]{0,99})\/pack\.yaml$/.exec(file);
      return match ? [match[1]] : [];
    })));
    entry = { key, ids };
    committedPackIndex = entry;
  }
  try { return await entry.ids; }
  catch (error) {
    if (committedPackIndex === entry) committedPackIndex = null;
    throw error;
  }
}

export async function readCaseIqPackCatalog(root: string, sourceCommit: string): Promise<CaseIqInstallation["packs"]> {
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) {
    throw new CaseIqIntegrationError("CaseIQ support packs require a readable source revision.");
  }
  const packsRoot = path.join(/* turbopackIgnore: true */ root, "support-packs");
  await requirePlainCaseIqDirectory(packsRoot);
  const packs: CaseIqInstallation["packs"] = [];
  for (const id of await committedPackIds(root, sourceCommit)) {
    await requirePlainCaseIqDirectory(path.join(packsRoot, id));
    const manifestPath = path.join(packsRoot, id, "pack.yaml");
    const manifest = await lstat(/* turbopackIgnore: true */ manifestPath);
    if (!manifest.isFile() || manifest.isSymbolicLink()) {
      throw new CaseIqIntegrationError("A committed CaseIQ pack manifest is not a regular file. Revalidate the installation outside WorkBoard.");
    }
    const parsed = z.object({ metadata: z.object({ id: z.string(), name: z.string().optional() }) })
      .parse(parseYaml(await readFile(/* turbopackIgnore: true */ manifestPath, "utf8")));
    if (parsed.metadata.id !== id) {
      throw new CaseIqIntegrationError("CaseIQ pack metadata is inconsistent; repair it outside WorkBoard.");
    }
    packs.push({ id, name: parsed.metadata.name ?? id });
  }
  return packs.sort((left, right) => left.name.localeCompare(right.name));
}

export async function getCaseIqInstallation(): Promise<CaseIqInstallation> {
  if (process.platform !== "win32") throw new CaseIqIntegrationError("CaseIQ integration requires a Windows execution host.");
  return inspectCaseIqInstallation(await readCaseIqRegistration());
}

export async function getCaseIqInstallationPaths(): Promise<Pick<NativeInstallationIdentity, "launcherPath" | "nativeExecutable">> {
  const registration = await readCaseIqRegistration();
  const registeredRoot = registration.root;
  const root = await realpath(/* turbopackIgnore: true */ registeredRoot);
  return { launcherPath: path.join(root, "caseiq.ps1"), nativeExecutable: resolveCopilotCliExecutable() };
}

async function inspectCaseIqInstallation(registration: CaseIqRegistration): Promise<CaseIqInstallation> {
  const registeredRoot = registration.root;
  const canonicalRoot = await realpath(/* turbopackIgnore: true */ registeredRoot);
  const launcherPath = path.join(canonicalRoot, "caseiq.ps1");
  const source = await readFile(/* turbopackIgnore: true */ launcherPath);
  const launcherSha256 = createHash("sha256").update(source).digest("hex");
  const git = async (...args: string[]) => (await executeFile("git", ["-C", canonicalRoot, ...args], {
    windowsHide: true, timeout: 10_000,
  })).stdout.trim();
  const [commit, branch, dirty] = await Promise.all([
    git("rev-parse", "HEAD"), git("branch", "--show-current"), git("status", "--porcelain", "--untracked-files=no"),
  ]);
  assertCaseIqCheckout(commit);
  const nativeExecutable = resolveCopilotCliExecutable();
  const [version, help] = await Promise.all([
    executeFile(nativeExecutable, ["--no-auto-update", "--version"], { windowsHide: true, timeout: 10_000 }),
    executeFile(nativeExecutable, ["--no-auto-update", "--help"], { windowsHide: true, timeout: 10_000 }),
  ]);
  const nativeVersion = verifyCaseIqCli(version.stdout, help.stdout);
  if (!await command("gh.exe")) {
    throw new CaseIqIntegrationError("GitHub CLI is required by the original CaseIQ launcher. Prepare it on the execution host, then retry.");
  }
  await Promise.all(["runtime", "telemetry"].map((directory) =>
    requirePlainCaseIqDirectory(path.join(canonicalRoot, directory))));
  const packs = await readCaseIqPackCatalog(canonicalRoot, commit);
  if (!packs.some((pack) => pack.id === "platform")) {
    throw new CaseIqIntegrationError("The committed CaseIQ platform support pack is unavailable. Revalidate the installation outside WorkBoard.");
  }
  return {
    root: canonicalRoot, launcherPath, launcherSha256, nativeExecutable, sourceCommit: commit, nativeVersion,
    sourceBranch: branch || null, sourceDirty: Boolean(dirty),
    packs,
  };
}

let pendingStatus: Promise<CaseIqStatus> | null = null;

export function getCaseIqStatus(): Promise<CaseIqStatus> {
  if (!pendingStatus) pendingStatus = readCaseIqStatus().finally(() => { pendingStatus = null; });
  return pendingStatus;
}

async function readCaseIqStatus(): Promise<CaseIqStatus> {
  const webExecution = { supported: true, reason: CASEIQ_WEB_LIMITATION, fallback: "none" as const };
  let registration: CaseIqRegistration | null = null;
  try {
    registration = await readCaseIqRegistration();
    if (process.platform !== "win32") throw new CaseIqIntegrationError("CaseIQ integration requires a Windows execution host.");
    const installation = await inspectCaseIqInstallation(registration);
    try {
      await getCaseIqPromptPowerShell();
    } catch (error) {
      if (!(error instanceof CaseIqIntegrationError)) throw error;
      webExecution.supported = false;
      webExecution.reason = error.message;
    }
    const prefix = path.join(getCaseIqStateRoot(), "packages");
    const scope = await command("conductor-scope-assist") ?? await command("scope-assist");
    const localScope = await readOptionalCaseIqText(path.join(prefix, "conductor-scope-assist.cmd")) ??
      await readOptionalCaseIqText(path.join(prefix, "scope-assist.cmd"));
    return {
      configured: true, launchable: true, reason: null, sourceCommit: installation.sourceCommit,
      compatibilityKey: nativeBindingCompatibilityKey(installation),
      packs: installation.packs,
      warnings: [
        ...(!webExecution.supported ? [webExecution.reason] : []),
        ...(scope || localScope !== null ? [] : ["Scope Assist was not detected. The original launcher may need dependency/package authentication setup; a web Run reports preparation failures instead of opening Terminal."]),
        "SafeWright is optional for browser workflows; a missing global command is not a launch blocker.",
        "CaseIQ keeps its native plugins, permissions and telemetry. WorkBoard does not grant unrestricted CLI access or answer authentication/approval prompts.",
      ],
      webExecution,
    };
  } catch (error) {
    if (error instanceof CaseIqRegistrationError && error.cause !== undefined) {
      console.error("[CaseIQ] Host registration could not be read.", error.cause);
    } else if (!(error instanceof CaseIqIntegrationError)) {
      console.error("[CaseIQ] Readiness probe failed.", error);
    }
    return {
      configured: registration !== null || error instanceof CaseIqRegistrationError && error.configured,
      launchable: false, reason: process.platform !== "win32" ? "CaseIQ integration requires a Windows execution host."
        : error instanceof CaseIqIntegrationError ? error.message : "CaseIQ installation could not be verified. Check host configuration and server logs.",
      sourceCommit: null, compatibilityKey: null, packs: [], warnings: [], webExecution,
    };
  }
}
