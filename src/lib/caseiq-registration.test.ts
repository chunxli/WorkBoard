import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCaseIqInstallation, getCaseIqStatus, readCaseIqRegistration } from "./caseiq-installation";
import { CaseIqIntegrationError } from "./caseiq-errors";

let root: string;
let registrationFile: string;
function registration() {
  return {
    root: path.join(root, "trusted-installation"),
    launcherSha256: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    nativeVersion: "1.0.106",
  };
}
async function saveRegistration(content: string) {
  await mkdir(path.dirname(registrationFile), { recursive: true });
  await writeFile(registrationFile, content, "utf8");
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-registration-"));
  registrationFile = path.join(root, "data", "caseiq", "installation.json");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("WORKBOARD_CASEIQ_ROOT", "");
  vi.stubEnv("WORKBOARD_CASEIQ_LAUNCHER_SHA256", "");
  vi.stubEnv("WORKBOARD_CASEIQ_COMMIT", "");
  vi.stubEnv("WORKBOARD_CASEIQ_CLI_VERSION", "");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("CaseIQ host registration isolation", () => {
  it.each(["", "\uFEFF"])("reads valid JSON with an optional Windows UTF-8 BOM without rewriting it (%j)", async (prefix) => {
    const expected = registration();
    const content = `${prefix}${JSON.stringify(expected)}`;
    await saveRegistration(content);
    await expect(readCaseIqRegistration()).resolves.toEqual({ root: expected.root });
    expect(await readFile(registrationFile, "utf8")).toBe(content);
  });

  it("uses the environment root without merging JSON or applying old version pins", async () => {
    await saveRegistration(JSON.stringify(registration()));
    const selected = path.join(root, "environment-installation");
    vi.stubEnv("WORKBOARD_CASEIQ_ROOT", `  ${selected}  `);
    vi.stubEnv("WORKBOARD_CASEIQ_LAUNCHER_SHA256", "C".repeat(64));
    vi.stubEnv("WORKBOARD_CASEIQ_COMMIT", "D".repeat(40));
    vi.stubEnv("WORKBOARD_CASEIQ_CLI_VERSION", "1.0.107");
    await expect(readCaseIqRegistration()).resolves.toEqual({
      root: selected,
    });
  });

  it("does not apply environment pins to JSON mode without an environment root", async () => {
    await saveRegistration(JSON.stringify(registration()));
    vi.stubEnv("WORKBOARD_CASEIQ_ROOT", "   ");
    vi.stubEnv("WORKBOARD_CASEIQ_COMMIT", "invalid-ignored-pin");
    vi.stubEnv("WORKBOARD_CASEIQ_CLI_VERSION", "invalid-ignored-version");
    await expect(readCaseIqRegistration()).resolves.toEqual({ root: registration().root });
  });

  it("does not fall back to valid JSON when the selected environment registration is invalid", async () => {
    await saveRegistration(JSON.stringify(registration()));
    vi.stubEnv("WORKBOARD_CASEIQ_ROOT", "relative-installation");
    await expect(readCaseIqRegistration()).rejects.toThrow("absolute path");
  });

  it("keeps a missing registration unconfigured, including a whitespace-only environment root", async () => {
    vi.stubEnv("WORKBOARD_CASEIQ_ROOT", "  ");
    await expect(readCaseIqRegistration()).rejects.toBeInstanceOf(CaseIqIntegrationError);
    await expect(getCaseIqStatus()).resolves.toMatchObject({ configured: false, launchable: false });
  });

  it("reports invalid JSON without echoing private text or persisting an unavailable result", async () => {
    await saveRegistration('{"private-fixture-text":');
    const unavailable = await getCaseIqStatus();
    expect(unavailable).toMatchObject({ configured: true, launchable: false });
    expect(JSON.stringify(unavailable)).not.toContain("private-fixture-text");
    await saveRegistration(JSON.stringify(registration()));
    await expect(readCaseIqRegistration()).resolves.toEqual({ root: registration().root });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refreshed = await getCaseIqStatus();
    expect(refreshed).not.toBe(unavailable);
    if (process.platform === "win32") expect(refreshed.reason).not.toContain("invalid JSON");
  });

  it.each([
    { label: "unknown fields", changes: { command: "not-an-option" } },
    { label: "relative root", changes: { root: "relative" } },
    { label: "null root", changes: { root: `C:\\invalid\0root` } },
  ])("rejects $label in host JSON", async ({ changes }) => {
    await saveRegistration(JSON.stringify({ ...registration(), ...changes }));
    await expect(readCaseIqRegistration()).rejects.toBeInstanceOf(CaseIqIntegrationError);
  });

  it("accepts root-only registration and ignores legacy version fields without rewriting them", async () => {
    const content = JSON.stringify({ root: registration().root, launcherSha256: "obsolete",
      sourceCommit: "old-version", nativeVersion: "retired" });
    await saveRegistration(content);
    expect(await readCaseIqRegistration()).toEqual({ root: registration().root });
    expect(await readFile(registrationFile, "utf8")).toBe(content);
    await saveRegistration(JSON.stringify({ root: registration().root }));
    expect(await readCaseIqRegistration()).toEqual({ root: registration().root });
  });

  it.skipIf(process.platform !== "win32")("does not read ignored JSON when an environment root is registered", async () => {
    const installation = path.join(root, "trusted-installation");
    await mkdir(installation);
    await mkdir(registrationFile, { recursive: true });
    vi.stubEnv("WORKBOARD_CASEIQ_ROOT", installation);
    await expect(getCaseIqInstallation()).rejects.toMatchObject({
      code: "ENOENT", path: path.join(installation, "caseiq.ps1"),
    });
  });

  it("reports an unreadable registration as unavailable instead of throwing again while building the error report", async () => {
    await mkdir(registrationFile, { recursive: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getCaseIqStatus()).resolves.toMatchObject({
      configured: true, launchable: false,
      reason: expect.stringContaining(process.platform === "win32" ? "registration" : "Windows"),
    });
    expect(log).toHaveBeenCalled();
  });
});
