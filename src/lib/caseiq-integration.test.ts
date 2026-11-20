import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readNativeSessionBindingSync, saveNativeSessionBinding, type NativeSessionBinding,
} from "./native-session-bindings";
import { getCopilotSessionEventsPath } from "./copilot-session-compat";
import { caseIqLaunchSchema, caseIqStatusSchema } from "./caseiq-options";
import { runtimeProviderLabel, webFollowUpBlockedReason } from "./runtime-provider";
import { resolveTerminalRunOutcome } from "./terminal-resume";
import { listWorkDirectory, previewWorkFile } from "./work-directory-browser";
import { captureDirectorySnapshot } from "./directory-snapshot";
import type { CopilotCompletionSummary } from "./copilot-completion";
import { acceptCaseIqPreparation } from "./caseiq-integration";
import { assertCaseIqCheckout, verifyCaseIqCli } from "./caseiq-installation";
import { NATIVE_BRIDGE_PROTOCOL } from "../../scripts/native-bridge-protocol.mjs";

let root: string;
let stateRoot: string;
let binding: NativeSessionBinding;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-state-"));
  stateRoot = path.join(root, "private-runtime");
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", stateRoot);
  vi.stubEnv("COPILOT_HOME", path.join(root, "legacy-home"));
  binding = {
    bindingVersion: 1, providerId: "caseiq", sessionId: randomUUID(), userId: "owner", workId: "work",
    hostname: hostname(), home: path.join(root, "actual-native-home"),
    launcherPath: path.join(root, "caseiq.ps1"), launcherSha256: "a".repeat(64), sourceCommit: "b".repeat(40),
    nativeExecutable: process.execPath, nativeVersion: "1.0.105", workingDirectory: path.join(root, "work"),
    packs: ["platform"], caseNumber: null,
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("private CaseIQ session binding", () => {
  it("uses the bound home rather than the process-global Copilot home", async () => {
    await saveNativeSessionBinding(binding);
    expect(getCopilotSessionEventsPath(binding.sessionId)).toBe(
      path.join(binding.home!, "session-state", binding.sessionId, "events.jsonl"),
    );
    expect(getCopilotSessionEventsPath(binding.sessionId, path.join(root, "explicit"))).toBe(
      path.join(root, "explicit", "session-state", binding.sessionId, "events.jsonl"),
    );
    expect(getCopilotSessionEventsPath(randomUUID())).toContain("legacy-home");
  });

  it("does not fall back to another home while CaseIQ is still preparing", async () => {
    await saveNativeSessionBinding({ ...binding, home: null });
    expect(() => getCopilotSessionEventsPath(binding.sessionId)).toThrow("Waiting for CaseIQ");
    await saveNativeSessionBinding(binding);
    expect(readNativeSessionBindingSync(binding.sessionId)?.home).toBe(binding.home);
  });

  it("refuses a different owner, Work, or home for the same native session", async () => {
    await saveNativeSessionBinding(binding);
    await expect(saveNativeSessionBinding({ ...binding, userId: "another" })).rejects.toThrow("different");
    await expect(saveNativeSessionBinding({ ...binding, workId: "foreign-work" })).rejects.toThrow("different");
    await expect(saveNativeSessionBinding({ ...binding, home: path.join(root, "wrong") })).rejects.toThrow("different");
    await expect(saveNativeSessionBinding({ ...binding, nativeExecutable: path.join(root, "other.exe") })).rejects.toThrow("different");
    await expect(saveNativeSessionBinding({ ...binding, launcherPath: path.join(root, "other.ps1") })).rejects.toThrow("different");
  });

  it("records new runtime versions without replacing Session ownership or its home", async () => {
    await saveNativeSessionBinding(binding);
    const updated = { ...binding, sourceCommit: "c".repeat(40), nativeVersion: "1.0.107", launcherSha256: "c".repeat(64) };
    await expect(saveNativeSessionBinding(updated)).resolves.toBeUndefined();
    expect(readNativeSessionBindingSync(binding.sessionId)).toEqual(updated);
    expect(getCopilotSessionEventsPath(binding.sessionId)).toContain(binding.home!);
  });

  it("surfaces corrupted private metadata rather than reading a legacy home", async () => {
    await saveNativeSessionBinding(binding);
    await writeFile(path.join(stateRoot, "bindings", `${binding.sessionId}.json`), "{bad");
    expect(() => getCopilotSessionEventsPath(binding.sessionId)).toThrow();
  });

  it("does not mistake an existing resumed home for acceptance of a new invocation", async () => {
    await saveNativeSessionBinding(binding);
    const directory = path.join(stateRoot, "requests", "resume-run");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "request.json"), JSON.stringify({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL, requestId: "request", runId: "resume-run",
      attemptId: "attempt", nonce: randomUUID(), launcherPath: binding.launcherPath,
      launcherSha256: binding.launcherSha256, nativeExecutable: process.execPath, nativeVersion: binding.nativeVersion,
      workingDirectory: binding.workingDirectory, sessionId: binding.sessionId, mode: "terminal",
      sendPrompt: false, prompt: "", resume: true,
    }));
    await expect(acceptCaseIqPreparation({
      id: "resume-run", workId: binding.workId, copilotSessionId: binding.sessionId,
    }, "launch")).resolves.toBe(false);
  });

  it("excludes private state from the Work file browser and directory snapshots", async () => {
    await mkdir(stateRoot);
    await writeFile(path.join(stateRoot, "private.json"), "private");
    await writeFile(path.join(root, "public.txt"), "public");
    const entries = await listWorkDirectory(root, "");
    expect(entries.entries.some((entry) => entry.name === "private-runtime")).toBe(false);
    await expect(previewWorkFile(root, "private-runtime/private.json")).rejects.toMatchObject({ status: 403 });
    const snapshot = await captureDirectorySnapshot(root);
    expect(snapshot.entries["public.txt"]).toBeDefined();
    expect(Object.keys(snapshot.entries).some((entry) => entry.startsWith("private-runtime"))).toBe(false);
    expect(await readFile(path.join(stateRoot, "private.json"), "utf8")).toBe("private");
  });
});

describe("CaseIQ capability and result boundaries", () => {
  it("checks required CLI capabilities without restricting a compatible version number", () => {
    const help = "--interactive --session-id --resume --plugin-dir --additional-mcp-config --allow-tool --disable-mcp-server --secret-env-vars --no-auto-update";
    expect(verifyCaseIqCli("GitHub Copilot CLI 1.0.106.", help)).toBe("1.0.106");
    expect(verifyCaseIqCli("GitHub Copilot CLI 2.0.0.", help)).toBe("2.0.0");
    expect(() => verifyCaseIqCli("GitHub Copilot CLI 1.0.106.", "")).toThrow("interface");
    expect(() => verifyCaseIqCli("GitHub Copilot CLI 1.0.106.", help.replace("--no-auto-update", ""))).toThrow("interface");
  });
  it("records a readable repository revision without an old commit/main/clean requirement", () => {
    expect(() => assertCaseIqCheckout("b".repeat(40))).not.toThrow();
    expect(() => assertCaseIqCheckout("not-a-revision")).toThrow("recorded");
  });
  it("does not accept an executable or arbitrary shell options from a launch request", () => {
    expect(caseIqLaunchSchema.parse({})).toEqual({ packs: [], caseNumber: null, sendPrompt: false });
    expect(caseIqLaunchSchema.safeParse({ root: "C:\\untrusted" }).success).toBe(false);
    expect(caseIqLaunchSchema.safeParse({ packs: ["../escape"] }).success).toBe(false);
    expect(caseIqStatusSchema.safeParse({ launchable: true }).success).toBe(false);
    expect(runtimeProviderLabel({ providerId: "caseiq", engine: "CLI" })).toContain("CaseIQ");
    expect(webFollowUpBlockedReason({ providerId: "caseiq" })).toContain("Resume");
    expect(webFollowUpBlockedReason({ providerId: "caseiq", engine: "CASEIQ" })).toBeNull();
    expect(runtimeProviderLabel({ providerId: "caseiq", engine: "CASEIQ" })).toBe("CaseIQ");
    expect(webFollowUpBlockedReason({ providerId: null })).toBeNull();
  });

  const completion = (): CopilotCompletionSummary => ({
    openSubagents: [], cancelledSubagents: [], failedSubagents: [], openTools: [],
    rootFinalOutput: null, taskComplete: false, sessionIdle: true, aborted: false,
  });

  it("does not turn a closed empty CaseIQ Terminal into successful task completion", () => {
    expect(resolveTerminalRunOutcome(0, completion(), true)).toMatchObject({ status: "UNKNOWN", exitCode: 0 });
    expect(resolveTerminalRunOutcome(0, completion()).status).toBe("SUCCESS");
    const done = { ...completion(), rootFinalOutput: "Completed" };
    expect(resolveTerminalRunOutcome(0, done, true)).toMatchObject({ status: "SUCCESS", exitCode: 0 });
    expect(resolveTerminalRunOutcome(0, { ...done, openTools: [{ id: "pending", name: "tool" }] }, true).status).toBe("UNKNOWN");
    expect(resolveTerminalRunOutcome(17, done, true).status).toBe("FAILED");
  });
});
