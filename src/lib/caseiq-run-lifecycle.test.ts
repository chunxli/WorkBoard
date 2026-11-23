import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeCorrelation, NATIVE_BRIDGE_PROTOCOL, parseNativeBridgeRequest } from "../../scripts/native-bridge-protocol.mjs";
import {
  authorizeCaseIqRunLaunch, inspectInterruptedCaseIqRun, persistCaseIqPrelaunchCancellation, prepareCaseIqRunLaunch,
  persistCaseIqRetryCancellation, requestCaseIqBridgeCancellation, requestInterruptedCaseIqCancellation,
} from "./caseiq-run-lifecycle";

const probe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/copilot-process", () => ({ windowsProcessMatchesStartTime: probe }));

let root: string;
let directory: string;
let run: { id: string; hostname: string; executionPath: string; copilotSessionId: string };
let request: ReturnType<typeof parseNativeBridgeRequest>;

beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-recovery-"));
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", path.join(root, "private"));
  run = { id: randomUUID(), hostname: hostname(), executionPath: path.join(root, "work"), copilotSessionId: randomUUID() };
  request = parseNativeBridgeRequest({
    protocolVersion: NATIVE_BRIDGE_PROTOCOL, requestId: randomUUID(), runId: run.id,
    attemptId: randomUUID(), nonce: randomUUID(), launcherPath: path.join(root, "synthetic.ps1"),
    launcherSha256: "a".repeat(64), nativeExecutable: process.execPath, nativeVersion: "1.0.0",
    workingDirectory: run.executionPath, sessionId: run.copilotSessionId, prompt: "Synthetic input", trackPromptWrapper: true,
  });
  directory = path.join(root, "private", "requests", run.id, request.attemptId);
  await mkdir(directory, { recursive: true });
  await json("request.json", request);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { force: true, recursive: true });
});

function json(name: string, value: unknown) {
  return writeFile(path.join(directory, name), JSON.stringify(value));
}

function initializeLaunch() {
  return prepareCaseIqRunLaunch(run, async (folder) => { await mkdir(folder, { recursive: true }); });
}

async function accepted() {
  await json("prompt-wrapper.json", { ...bridgeCorrelation(request), pid: 1234, startTime: "134071000001234567" });
  await json("accept.json", { ...bridgeCorrelation(request), action: "accept", preparedHash: "b".repeat(64) });
}

async function completed({ nonce = request.nonce, timedOut = false, exitCode = null }: {
  nonce?: string; timedOut?: boolean; exitCode?: number | null;
} = {}) {
  const cancelled = !timedOut && exitCode === null;
  const bridgeExitCode = exitCode ?? (timedOut ? 124 : 130);
  await json("native-result.json", {
    ...bridgeCorrelation(request), kind: "native-result", sequence: 3, timestamp: new Date().toISOString(),
    pid: 2345, exitCode, signal: exitCode === null ? "SIGTERM" : null, cancelled, timedOut,
    forced: exitCode === null, error: null,
  });
  await json("launcher-result.json", {
    ...bridgeCorrelation(request), nonce, launcherExitCode: bridgeExitCode, nativeExitCode: exitCode, bridgeExitCode,
    scriptError: false, nativeExecutionObserved: true, errorKind: "native-process-failed",
  });
}

describe("interrupted CaseIQ exit evidence", () => {
  it("releases a Run interrupted before launcher authorization even when its first request is incomplete", async () => {
    await initializeLaunch();
    await writeFile(path.join(directory, "request.json"), "{");
    expect(await inspectInterruptedCaseIqRun(run)).toEqual({
      stopped: true, cancelled: false, timedOut: false, beforeLaunch: true, completedRequests: [],
    });
    await expect(authorizeCaseIqRunLaunch(run)).rejects.toThrow("No Prompt was sent");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ["live", persistCaseIqPrelaunchCancellation],
    ["interrupted", requestInterruptedCaseIqCancellation],
  ] as const)("preserves %s cancellation across recovery even without an attempt record", async (_source, cancel) => {
    await initializeLaunch();
    await rm(directory, { recursive: true });
    await cancel(run);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, cancelled: true, beforeLaunch: true });
    await expect(authorizeCaseIqRunLaunch(run)).resolves.toBe("cancelled");
  });

  it("does not acknowledge user cancellation over a different stop already recorded after authorization", async () => {
    await initializeLaunch();
    expect(await authorizeCaseIqRunLaunch(run)).toBe("authorized");
    await requestCaseIqBridgeCancellation(directory, request, "shutdown");
    await expect(persistCaseIqPrelaunchCancellation(run, { directory, request })).rejects.toThrow("different stop request");
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, cancelled: false });
  });

  it.each(["timeout", "shutdown"] as const)("does not acknowledge interrupted cancellation over an existing %s stop", async (reason) => {
    await accepted();
    await requestCaseIqBridgeCancellation(directory, request, reason);
    await expect(requestInterruptedCaseIqCancellation(run)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("different stop request"),
    });
    expect(JSON.parse(await readFile(path.join(directory, "cancel.json"), "utf8"))).toEqual({
      ...bridgeCorrelation(request), action: "cancel", reason,
    });
  });

  it("does not mistake missing attempt evidence after authorization for an unlaunched Run", async () => {
    await initializeLaunch();
    await authorizeCaseIqRunLaunch(run);
    await rm(directory, { recursive: true });
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false, cancelled: false });
    await rm(path.join(root, "private", "web-launches", run.id, "decision.json"));
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false, cancelled: false });
  });

  it("allows only one of concurrent launch authorization and prelaunch recovery to succeed", async () => {
    await initializeLaunch();
    await rm(directory, { recursive: true });
    const [launch, recovery] = await Promise.allSettled([authorizeCaseIqRunLaunch(run), inspectInterruptedCaseIqRun(run)]);
    expect(recovery.status).toBe("fulfilled");
    if (recovery.status === "fulfilled") expect(recovery.value.stopped).toBe(launch.status === "rejected");
  });

  it("does not release an accepted attempt until both the receipts and wrapper exit are confirmed", async () => {
    await accepted();
    probe.mockResolvedValue(true);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false });
    await requestInterruptedCaseIqCancellation(run);
    await requestInterruptedCaseIqCancellation(run);
    const decision = JSON.parse(await readFile(path.join(directory, "cancel.json"), "utf8"));
    expect(decision).toEqual({ ...bridgeCorrelation(request), action: "cancel", reason: "user" });
    await completed();
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false });
    expect(probe).toHaveBeenCalledWith(1234, "134071000001234567");
    probe.mockResolvedValue(false);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, cancelled: true });
  });

  it("recovers a native timeout only after the wrapper's exit is verified", async () => {
    await accepted();
    await completed({ timedOut: true });
    probe.mockResolvedValue(true);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false, timedOut: false });
    probe.mockResolvedValue(false);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, timedOut: true, cancelled: false });
  });

  it("does not equate a timeout request or an ordinary exit code of 124 with a confirmed timeout", async () => {
    await accepted();
    await requestCaseIqBridgeCancellation(directory, request, "timeout");
    probe.mockResolvedValue(false);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false, timedOut: false });
    await completed({ exitCode: 124 });
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, timedOut: false, cancelled: false });
  });

  it("preserves a timeout when an attempt was fenced before the wrapper started", async () => {
    await requestCaseIqBridgeCancellation(directory, request, "timeout");
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, timedOut: true, cancelled: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("preserves a timeout when the tracked wrapper reports it stopped before invocation", async () => {
    await json("prompt-wrapper.json", { ...bridgeCorrelation(request), pid: 1234, startTime: "134071000001234567" });
    await requestCaseIqBridgeCancellation(directory, request, "timeout");
    await json("launcher-result.json", {
      ...bridgeCorrelation(request), launcherExitCode: 130, nativeExitCode: null, bridgeExitCode: 1,
      scriptError: false, nativeExecutionObserved: null, errorKind: "native-result-missing",
    });
    probe.mockResolvedValue(false);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, timedOut: true, cancelled: false });
  });

  it("does not treat a retry stop request as evidence that the earlier wrapper exited", async () => {
    await accepted();
    await persistCaseIqRetryCancellation(directory, request);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false });
    await completed();
    probe.mockResolvedValue(true);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false });
    probe.mockResolvedValue(false);
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: true, cancelled: true });
  });

  it("seals an unlaunched tracked attempt without treating it as a user cancellation", async () => {
    expect(await inspectInterruptedCaseIqRun(run)).toEqual({ stopped: true, cancelled: false, timedOut: false, completedRequests: [] });
    const decision = JSON.parse(await readFile(path.join(directory, "cancel.json"), "utf8"));
    expect(decision).toEqual({ ...bridgeCorrelation(request), action: "cancel", reason: "shutdown" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not automatically stop an accepted attempt whose wrapper record is missing", async () => {
    await accepted();
    await rm(path.join(directory, "prompt-wrapper.json"));
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false });
    await expect(readFile(path.join(directory, "cancel.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps missing and legacy attempt state reserved and refuses mismatched completion evidence", async () => {
    await json("request.json", { ...request, trackPromptWrapper: undefined });
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false });
    await accepted();
    await completed({ nonce: randomUUID() });
    await expect(inspectInterruptedCaseIqRun(run)).rejects.toThrow("does not match this attempt");
    await rm(directory, { recursive: true });
    expect(await inspectInterruptedCaseIqRun(run)).toMatchObject({ stopped: false });
  });
});
