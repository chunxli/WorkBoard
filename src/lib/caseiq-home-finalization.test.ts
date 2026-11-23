import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { finalizeCaseIqSessionHome } from "./caseiq-integration";
import { readNativeSessionBindingSync, saveNativeSessionBinding, type NativeSessionBinding } from "./native-session-bindings";
import { getCopilotSessionEventsPath } from "./copilot-session-compat";
import { bridgeCorrelation, NATIVE_BRIDGE_PROTOCOL, parseNativeBridgeRequest } from "../../scripts/native-bridge-protocol.mjs";

let root: string;
let binding: NativeSessionBinding;
let requestFile: string;
let finalHome: string;
let run: { id: string; workId: string; copilotSessionId: string };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-final-home-"));
  const state = path.join(root, "private-state");
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", state);
  run = { id: randomUUID(), workId: "work", copilotSessionId: randomUUID() };
  const home = path.join(state, "native", run.copilotSessionId, "cases", "sessions", "temporary-launch");
  binding = {
    bindingVersion: 1, providerId: "caseiq", sessionId: run.copilotSessionId, userId: "owner", workId: run.workId,
    hostname: hostname(), home, launcherPath: path.join(root, "caseiq.ps1"), launcherSha256: "a".repeat(64),
    sourceCommit: "b".repeat(40), nativeExecutable: process.execPath, nativeVersion: "1.0.107",
    workingDirectory: path.join(root, "work"), packs: [], caseNumber: null,
  };
  await mkdir(path.join(home, "session-state", run.copilotSessionId), { recursive: true });
  await writeFile(path.join(home, "session-state", run.copilotSessionId, "events.jsonl"),
    `${JSON.stringify({ type: "assistant.message", data: { content: "Synthetic final reply" } })}\n`);
  await saveNativeSessionBinding(binding);
  finalHome = path.join(path.dirname(home), run.copilotSessionId);
  const directory = path.join(state, "requests", run.id, randomUUID());
  await mkdir(directory, { recursive: true });
  requestFile = path.join(directory, "request.json");
  const request = parseNativeBridgeRequest({
    protocolVersion: NATIVE_BRIDGE_PROTOCOL, requestId: randomUUID(), runId: run.id, attemptId: randomUUID(), nonce: randomUUID(),
    launcherPath: binding.launcherPath, launcherSha256: binding.launcherSha256, nativeExecutable: binding.nativeExecutable,
    nativeVersion: binding.nativeVersion, workingDirectory: binding.workingDirectory,
    sessionId: binding.sessionId, mode: "prompt", prompt: "Synthetic request",
  });
  const correlation = bridgeCorrelation(request);
  await Promise.all([
    writeFile(requestFile, JSON.stringify(request)),
    writeFile(path.join(directory, "accept.json"), JSON.stringify({ ...correlation, action: "accept", preparedHash: "c".repeat(64) })),
    writeFile(path.join(directory, "native-result.json"), JSON.stringify({
      ...correlation, kind: "native-result", sequence: 1, timestamp: new Date().toISOString(),
      pid: process.pid, exitCode: 0, signal: null, cancelled: false, timedOut: false, forced: false, error: null,
    })),
    writeFile(path.join(directory, "launcher-result.json"), JSON.stringify({
      ...correlation, launcherExitCode: 0, nativeExitCode: 0, bridgeExitCode: 0,
      scriptError: false, nativeExecutionObserved: true, errorKind: null,
    })),
  ]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("correlated CaseIQ final home", () => {
  it("can finalize an older completed invocation after a later version observation", async () => {
    await saveNativeSessionBinding({ ...binding, sourceCommit: "c".repeat(40),
      launcherSha256: "d".repeat(64), nativeVersion: "2.0.0" });
    await finalizeCaseIqSessionHome(run, requestFile);
    expect(readNativeSessionBindingSync(binding.sessionId)).toMatchObject({
      sourceCommit: "c".repeat(40), home: binding.home, nativeVersion: "2.0.0",
    });
  });

  it("records the exact renamed home while keeping the prepared home immutable", async () => {
    await rename(binding.home!, finalHome);
    await finalizeCaseIqSessionHome(run, requestFile);
    expect(readNativeSessionBindingSync(binding.sessionId)).toMatchObject({ home: binding.home, finalHome });
    expect(getCopilotSessionEventsPath(binding.sessionId)).toBe(path.join(finalHome, "session-state", binding.sessionId, "events.jsonl"));
    await finalizeCaseIqSessionHome(run, requestFile);
    const saved = readNativeSessionBindingSync(binding.sessionId)!;
    await expect(saveNativeSessionBinding({ ...saved, finalHome: undefined })).rejects.toThrow("different native session binding");
    await expect(saveNativeSessionBinding({ ...saved, home: path.join(path.dirname(binding.home!), "other") }))
      .rejects.toThrow("different native session binding");
  });

  it("retains an unchanged home when the original launcher does not rename it", async () => {
    await finalizeCaseIqSessionHome(run, requestFile);
    expect(readNativeSessionBindingSync(binding.sessionId)).toEqual(binding);
  });

  it("never guesses another sibling or the newest session", async () => {
    await rename(binding.home!, path.join(path.dirname(binding.home!), randomUUID()));
    await expect(finalizeCaseIqSessionHome(run, requestFile)).rejects.toThrow("No alternative home");
    expect(readNativeSessionBindingSync(binding.sessionId)?.finalHome).toBeUndefined();
  });

  it("requires matching completion and acceptance correlation", async () => {
    await rename(binding.home!, finalHome);
    const receipt = path.join(path.dirname(requestFile), "accept.json");
    const acceptance = JSON.parse(await readFile(receipt, "utf8"));
    await writeFile(receipt, JSON.stringify({ ...acceptance, nonce: randomUUID() }));
    await expect(finalizeCaseIqSessionHome(run, requestFile)).rejects.toThrow("does not match");
    expect(readNativeSessionBindingSync(binding.sessionId)?.finalHome).toBeUndefined();
  });

  it("rejects a different Work even when the files are otherwise valid", async () => {
    await rename(binding.home!, finalHome);
    await expect(finalizeCaseIqSessionHome({ ...run, workId: "foreign" }, requestFile)).rejects.toThrow("binding is missing");
    expect(readNativeSessionBindingSync(binding.sessionId)?.finalHome).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("rejects a junction instead of following it to another namespace", async () => {
    const outside = path.join(root, "outside-native-namespace");
    await rename(binding.home!, outside);
    await symlink(outside, finalHome, "junction");
    await expect(finalizeCaseIqSessionHome(run, requestFile)).rejects.toThrow("regular session directory");
    expect(readNativeSessionBindingSync(binding.sessionId)?.finalHome).toBeUndefined();
  });
});
