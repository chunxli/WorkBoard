import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  caseIqAuthenticationActivity, caseIqAuthenticationBlockedReason, caseIqAuthenticationDirectory,
  readCaseIqAuthentication, readCaseIqNativeConnection, writeCaseIqAuthentication, type StoredCaseIqAuthentication,
} from "./caseiq-authentication-state";
import { RunStartInProgressError, withRunStartLock } from "./run-start-lock";
import { bridgeCorrelation, parseNativeBridgeRequest } from "../../scripts/native-bridge-protocol.mjs";
import { getCaseIqSharedOAuthRoot, getCaseIqStateRoot } from "./native-runtime-paths";
import type { NativeSessionBinding } from "./native-session-bindings";

const processMocks = vi.hoisted(() => ({ matches: vi.fn(), alive: vi.fn(), started: vi.fn() }));
vi.mock("@/lib/copilot-process", async (original) => ({
  ...await original<typeof import("./copilot-process")>(), windowsProcessMatchesStartTime: processMocks.matches,
  readWindowsProcessStartTime: processMocks.started,
}));
vi.mock("@/lib/copilot-session-compat", async (original) => ({
  ...await original<typeof import("./copilot-session-compat")>(), processIsAlive: processMocks.alive,
}));
const matches = processMocks.matches;
let root: string;
let directory: string;
let operation: StoredCaseIqAuthentication;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workboard-auth-state-"));
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", root);
  operation = {
    id: randomUUID(), sessionId: randomUUID(), sourceRunId: randomUUID(),
    userId: "owner", workId: "work", hostname: hostname(), startedAt: new Date().toISOString(),
    launchRejected: false, errorMessage: null, trustWorkFolder: false,
  };
  directory = path.join(root, "requests", operation.id);
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(caseIqAuthenticationDirectory())]);
  await writeCaseIqAuthentication(operation);
  matches.mockReset().mockResolvedValue(false);
  processMocks.alive.mockReset().mockReturnValue(false);
  processMocks.started.mockReset().mockResolvedValue("134071000001234567");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function metadata(extra: object = {}) {
  await writeFile(path.join(directory, "terminal.json"), JSON.stringify({
    wrapperPid: 4242, wrapperStartTime: "134071000001234567", ...extra,
  }));
}
async function completion(nonce?: string) {
  const request = parseNativeBridgeRequest({
    protocolVersion: "workboard-native/1", requestId: randomUUID(), runId: operation.id,
    attemptId: randomUUID(), nonce: randomUUID(), launcherPath: path.join(root, "caseiq.ps1"),
    launcherSha256: "a".repeat(64), nativeExecutable: process.execPath, nativeVersion: "1.0.107",
    workingDirectory: root, sessionId: operation.sessionId, mode: "terminal", authenticationOnly: true,
    resume: true, prompt: "", sendPrompt: false,
  });
  const correlation = bridgeCorrelation(request);
  await writeFile(path.join(directory, "request.json"), JSON.stringify(request));
  await writeFile(path.join(directory, "native-result.json"), JSON.stringify({
    ...correlation, ...(nonce ? { nonce } : {}), kind: "native-result", sequence: 3,
    timestamp: new Date().toISOString(), pid: 4343, exitCode: 0, signal: null,
    cancelled: false, timedOut: false, forced: false, error: null,
  }));
  await writeFile(path.join(directory, "launcher-result.json"), JSON.stringify({
    ...correlation, launcherExitCode: 0, nativeExitCode: 0, bridgeExitCode: 0,
    scriptError: false, nativeExecutionObserved: true, errorKind: null,
  }));
}

async function interruptedWindow(home = root, oauthStorage?: NativeSessionBinding["oauthStorage"]) {
  await metadata({ exitCode: undefined });
  await completion();
  const request = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
  const cache = path.join(home, "mcp-oauth-config");
  if (oauthStorage?.mode === "shared") {
    const target = path.join(getCaseIqSharedOAuthRoot(operation.userId, request.launcherPath), oauthStorage.profileId, "mcp-oauth-config");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(target, { recursive: true })]);
    await symlink(target, cache, process.platform === "win32" ? "junction" : "dir");
  } else {
    await mkdir(cache, { recursive: true });
  }
  const correlation = bridgeCorrelation(request);
  const timestamp = new Date().toISOString();
  const preparedHash = "b".repeat(64);
  await writeFile(path.join(directory, "journal.jsonl"), [
    JSON.stringify({
      ...correlation, sequence: 1, timestamp, kind: "prepared", binding: {
        home, launchId: "auth-launch", caseNumber: null, workingDirectory: root,
        sessionId: operation.sessionId, resume: true, nativeVersion: "1.0.107",
        launcherSha256: "a".repeat(64), pluginDirectories: [], additionalMcpConfigs: [],
        instructionDirectories: [], allowTools: [], model: null, modelSource: "native-default",
        argumentsHash: "a".repeat(64), preparedHash,
        ...(oauthStorage ? { oauthStorage } : {}),
      },
    }),
    JSON.stringify({ ...correlation, sequence: 2, timestamp, kind: "native-spawn", pid: 4343 }),
    "",
  ].join("\n"));
  await writeFile(path.join(directory, "accept.json"), JSON.stringify({ ...correlation, action: "accept", preparedHash }));
  await rm(path.join(directory, "native-result.json"));
  await rm(path.join(directory, "launcher-result.json"));
}

async function observation(extra: object = {}) {
  const request = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
  await writeFile(path.join(directory, "mcp-status.json"), JSON.stringify({
    ...bridgeCorrelation(request), sessionId: operation.sessionId, preparedHash: "b".repeat(64),
    checkedAt: new Date().toISOString(), status: "connected", toolCount: 10, errorKind: null, ...extra,
  }));
  await writeFile(path.join(directory, "mcp-oauth-probe.json"), JSON.stringify({
    ...bridgeCorrelation(request), sessionId: operation.sessionId, preparedHash: "b".repeat(64),
    checkedAt: new Date().toISOString(), status: "authenticated", reason: null, httpStatus: 200, errorKind: null,
  }));
}

async function stagedObserver() {
  const home = path.join(root, "native", operation.sessionId, "home");
  await interruptedWindow(home);
  const request = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
  const observer = path.join(home, "extensions", `workboard-auth-${request.attemptId}`);
  await mkdir(observer, { recursive: true });
  const context = {
    correlation: bridgeCorrelation(request), sessionId: operation.sessionId,
    preparedHash: "b".repeat(64), requestDirectory: directory,
  };
  await writeFile(path.join(observer, "context.json"), JSON.stringify(context));
  await writeFile(path.join(observer, "extension.mjs"), "// synthetic test observer");
  return { observer, context };
}

describe("correlated native MCP verification", () => {
  it("invalidates old verification when the Session switches from a legacy cache to a shared profile", async () => {
    await interruptedWindow();
    await observation();
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({ status: "connected" });
    expect(await readCaseIqNativeConnection(operation, { mode: "shared", profileId: "c".repeat(64), reason: null }))
      .toMatchObject({ status: "unknown", checkedAt: null });
  });
  it("does not keep legacy green verification when cache links change before the new preparation is accepted", async () => {
    await interruptedWindow();
    await observation();
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({ status: "connected" });
    const target = path.join(getCaseIqSharedOAuthRoot(operation.userId, path.join(root, "caseiq.ps1")), "c".repeat(64), "mcp-oauth-config");
    await mkdir(target, { recursive: true });
    const cache = path.join(root, "mcp-oauth-config");
    await rm(cache, { recursive: true });
    await symlink(target, cache, process.platform === "win32" ? "junction" : "dir");
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({ status: "unknown", checkedAt: null });
  });
  it("accepts only the current shared profile's own correlated verification, not another profile or local cache", async () => {
    const storage = { mode: "shared" as const, profileId: "c".repeat(64), reason: null };
    await interruptedWindow(root, storage);
    await observation();
    expect(await readCaseIqNativeConnection(operation, storage)).toMatchObject({ status: "connected", toolCount: 10 });
    expect(await readCaseIqNativeConnection(operation, { ...storage, profileId: "d".repeat(64) }))
      .toMatchObject({ status: "unknown", checkedAt: null });
    expect(await readCaseIqNativeConnection(operation, { mode: "session", profileId: null, reason: "local-cache-preserved" }))
      .toMatchObject({ status: "unknown", checkedAt: null });
    const otherTarget = path.join(getCaseIqSharedOAuthRoot(operation.userId, path.join(root, "caseiq.ps1")), "d".repeat(64), "mcp-oauth-config");
    await mkdir(otherTarget, { recursive: true });
    await unlink(path.join(root, "mcp-oauth-config"));
    await symlink(otherTarget, path.join(root, "mcp-oauth-config"), process.platform === "win32" ? "junction" : "dir");
    expect(await readCaseIqNativeConnection(operation, storage)).toMatchObject({ status: "unknown", checkedAt: null });
    expect(await readCaseIqNativeConnection(operation, storage, { allowTransientLauncherReset: true }))
      .toMatchObject({ status: "unknown", checkedAt: null });
  });

  it("tolerates transient launcher junction resets inside the active native Session without flickering unverified state", async () => {
    const storage = { mode: "shared" as const, profileId: "c".repeat(64), reason: null };
    const sessionHome = path.join(getCaseIqStateRoot(), "native", operation.sessionId, "cases", "_unclassified", "sessions", operation.sessionId);
    const launcherStaging = path.join(getCaseIqStateRoot(), "native", operation.sessionId, "home", "instances", "inst", "shared", "mcp-oauth-config");
    await mkdir(launcherStaging, { recursive: true });
    await interruptedWindow(sessionHome, storage);
    await observation();

    await unlink(path.join(sessionHome, "mcp-oauth-config"));
    await symlink(launcherStaging, path.join(sessionHome, "mcp-oauth-config"), process.platform === "win32" ? "junction" : "dir");

    expect(await readCaseIqNativeConnection(operation, storage)).toMatchObject({ status: "unknown", checkedAt: null });
    expect(await readCaseIqNativeConnection(operation, storage, { allowTransientLauncherReset: true }))
      .toMatchObject({ status: "connected", toolCount: 10 });
  });

  it("does not equate an open wrapper with a started native Session", async () => {
    await metadata();
    matches.mockResolvedValue(true);
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({
      status: "active", reserved: true, phase: "preparing", trustWorkFolder: false,
    });
  });
  it("reports native startup only from the accepted and correlated native-spawn journal", async () => {
    await interruptedWindow();
    matches.mockResolvedValue(true);
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({
      status: "active", reserved: true, phase: "native-started",
    });
    const file = path.join(directory, "accept.json");
    const value = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...value, nonce: randomUUID() }));
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow();
  });

  it("does not accept legacy connection/tools-only evidence as OAuth verification", async () => {
    await interruptedWindow();
    await observation();
    await rm(path.join(directory, "mcp-oauth-probe.json"));
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({ status: "unknown", toolCount: null });
  });
  it.each(["needs-auth", "no-auth-required", "failed", "unknown"])("does not verify a connected server with OAuth outcome %s", async (status) => {
    await interruptedWindow();
    await observation();
    const file = path.join(directory, "mcp-oauth-probe.json");
    const value = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...value, status, reason: status === "needs-auth" ? "initial" : null }));
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({
      status: status === "needs-auth" ? "needs-auth" : "unknown", toolCount: null,
    });
  });
  it.each([
    { nonce: randomUUID() }, { preparedHash: "c".repeat(64) }, { sessionId: randomUUID() },
    { checkedAt: new Date(Date.now() - 60_000).toISOString() },
  ])("rejects mismatched OAuth evidence: %j", async (extra) => {
    await interruptedWindow();
    await observation();
    const file = path.join(directory, "mcp-oauth-probe.json");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), ...extra }));
    await expect(readCaseIqNativeConnection(operation)).rejects.toThrow();
  });

  it("keeps missing native evidence unknown", async () => {
    expect(await readCaseIqNativeConnection(operation)).toEqual({ status: "unknown", toolCount: null, checkedAt: null });
  });
  it("accepts a real positive receipt only with the same accepted native invocation", async () => {
    await interruptedWindow();
    await observation();
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({ status: "connected", toolCount: 10 });
  });
  it.each([
    { nonce: randomUUID() }, { sessionId: randomUUID() }, { runId: randomUUID() }, { preparedHash: "c".repeat(64) },
    { checkedAt: new Date(Date.now() - 60_000).toISOString() }, { checkedAt: new Date(Date.now() + 60_000).toISOString() },
    { toolCount: 0 }, { errorKind: "native-mcp-verification-failed" },
  ])("rejects mismatched or invalid verification evidence: %j", async (extra) => {
    await interruptedWindow();
    await observation(extra);
    await expect(readCaseIqNativeConnection(operation)).rejects.toThrow();
  });
  it("rejects a receipt without a recorded native spawn", async () => {
    await interruptedWindow();
    await observation();
    const journal = await readFile(path.join(directory, "journal.jsonl"), "utf8");
    await writeFile(path.join(directory, "journal.jsonl"), `${journal.split("\n")[0]}\n`);
    await expect(readCaseIqNativeConnection(operation)).rejects.toThrow("accepted native invocation");
  });
  it("does not turn needs-auth into verification", async () => {
    await interruptedWindow();
    await observation({ status: "needs-auth", toolCount: null });
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({ status: "needs-auth", toolCount: null });
  });
  it("removes only its stopped observer and preserves the verification receipt", async () => {
    const { observer } = await stagedObserver();
    await observation();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ reserved: false, status: "closed" });
    await expect(readFile(path.join(observer, "extension.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readCaseIqNativeConnection(operation)).toMatchObject({ status: "connected", toolCount: 10 });
  });
  it("coalesces concurrent stopped-state checks while removing the same owned observer", async () => {
    const { observer } = await stagedObserver();
    const states = await Promise.all([caseIqAuthenticationActivity(operation), caseIqAuthenticationActivity(operation)]);
    expect(states).toEqual([expect.objectContaining({ reserved: false }), expect.objectContaining({ reserved: false })]);
    expect(matches).toHaveBeenCalledOnce();
    await expect(readFile(path.join(observer, "extension.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps an observer while its native process is alive", async () => {
    const { observer } = await stagedObserver();
    processMocks.alive.mockReturnValue(true);
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ reserved: true });
    await expect(readFile(path.join(observer, "extension.mjs"), "utf8")).resolves.toContain("synthetic");
  });
  it("does not remove an observer with another operation's context", async () => {
    const { observer, context } = await stagedObserver();
    await writeFile(path.join(observer, "context.json"), JSON.stringify({
      ...context, correlation: { ...context.correlation, nonce: randomUUID() },
    }));
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow("nonce");
    await expect(readFile(path.join(observer, "extension.mjs"), "utf8")).resolves.toContain("synthetic");
  });
  it("does not recursively remove unexpected files", async () => {
    const { observer } = await stagedObserver();
    await writeFile(path.join(observer, "keep.txt"), "preserve");
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow("unexpected files");
    await expect(readFile(path.join(observer, "keep.txt"), "utf8")).resolves.toBe("preserve");
  });
});

describe("persistent CaseIQ authentication ownership", () => {
  it("reserves an opening request and blocks Work/session starts without creating a Run", async () => {
    expect(await readCaseIqAuthentication("work")).toMatchObject({ id: operation.id, sessionId: operation.sessionId });
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "opening", reserved: true });
    await expect(withRunStartLock(["work:work"], async () => "unexpected")).rejects.toBeInstanceOf(RunStartInProgressError);
    expect(await caseIqAuthenticationBlockedReason([`session:${operation.sessionId}`])).toContain("SupportIQ authentication");
    await expect(withRunStartLock(["work:another"], async () => "unrelated")).resolves.toBe("unrelated");
  });

  it("requires the exact wrapper FILETIME, not merely a reused PID", async () => {
    await metadata();
    matches.mockResolvedValueOnce(true);
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "active", reserved: true });
    expect(matches).toHaveBeenCalledWith(4242, "134071000001234567");
    operation.startedAt = new Date(Date.now() - 180_000).toISOString();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "unconfirmed", reserved: true });
  });

  it("does not release an alive wrapper even when completion files exist", async () => {
    await metadata({ exitCode: 0 });
    await completion();
    matches.mockResolvedValue(true);
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "active", reserved: true });
  });

  it("releases only correlated, stopped execution and never claims MCP authorization", async () => {
    await metadata({ exitCode: 0 });
    await completion();
    const status = await caseIqAuthenticationActivity(operation);
    expect(status).toMatchObject({ status: "closed", reserved: false });
    expect(status.message).toContain("not yet independently verified");
    expect(status).not.toHaveProperty("home");
    await expect(withRunStartLock(["work:work"], async () => "new prompt")).resolves.toBe("new prompt");
  });

  it("keeps terminal exit or a claimed login/cache change unconfirmed without receipts", async () => {
    await metadata({ exitCode: 0, authenticated: true, tokenCacheUpdated: true });
    operation.startedAt = new Date(Date.now() - 180_000).toISOString();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "unconfirmed", reserved: true });
  });

  it("recovers an interrupted window when its correlated wrapper and native processes have stopped", async () => {
    await interruptedWindow();
    const state = await caseIqAuthenticationActivity(operation);
    expect(state).toMatchObject({ status: "closed", reserved: false });
    expect(state.message).toContain("authorization is still unverified");
    expect(processMocks.alive).toHaveBeenCalledWith(4343);
    await expect(withRunStartLock(["work:work"], async () => "Follow Up allowed")).resolves.toBe("Follow Up allowed");
  });

  it("keeps an alive or reused native PID reserved when final receipts are missing", async () => {
    await interruptedWindow();
    processMocks.alive.mockReturnValue(true);
    operation.startedAt = new Date(Date.now() - 180_000).toISOString();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "unconfirmed", reserved: true });
  });

  it("never resurrects a positively confirmed stopped operation when its old native PID is reused", async () => {
    await interruptedWindow();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "closed", reserved: false });
    processMocks.alive.mockReturnValue(true);
    matches.mockClear();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "closed", reserved: false });
    expect(matches).not.toHaveBeenCalled();
    expect(processMocks.started).not.toHaveBeenCalled();
  });

  it("still validates the accepted request before trusting a persisted stop confirmation", async () => {
    await interruptedWindow();
    await caseIqAuthenticationActivity(operation);
    const file = path.join(directory, "authentication-stopped.json");
    const stopped = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...stopped, nonce: randomUUID() }));
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow("nonce");
  });

  it("does not hide final native failure receipts behind a confirmed stop", async () => {
    await interruptedWindow();
    await caseIqAuthenticationActivity(operation);
    const request = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
    const correlation = bridgeCorrelation(request);
    await metadata({ exitCode: 1 });
    await writeFile(path.join(directory, "native-result.json"), JSON.stringify({
      ...correlation, kind: "native-result", sequence: 3, timestamp: new Date().toISOString(),
      pid: 4343, exitCode: 1, signal: null, cancelled: false, timedOut: false, forced: false, error: null,
    }));
    await writeFile(path.join(directory, "launcher-result.json"), JSON.stringify({
      ...correlation, launcherExitCode: 1, nativeExitCode: 1, bridgeExitCode: 1,
      scriptError: false, nativeExecutionObserved: true, errorKind: null,
    }));
    matches.mockClear();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "failed", reserved: false });
    expect(matches).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")("can prove a live PID belongs to a process created after the original native spawn", async () => {
    await interruptedWindow();
    const file = path.join(directory, "journal.jsonl");
    const frames = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    frames[1].timestamp = new Date(Date.now() - 60_000).toISOString();
    await writeFile(file, `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
    processMocks.alive.mockReturnValue(true);
    processMocks.started.mockResolvedValue((BigInt(Date.now()) * BigInt(10000) + BigInt("116444736000000000")).toString());
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "closed", reserved: false });
    expect(processMocks.started).toHaveBeenCalledWith(4343);
  });

  it("does not recover a journal with the wrong acceptance or sequence", async () => {
    await interruptedWindow();
    const acceptance = JSON.parse(await readFile(path.join(directory, "accept.json"), "utf8"));
    await writeFile(path.join(directory, "accept.json"), JSON.stringify({ ...acceptance, nonce: randomUUID() }));
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow("nonce");
    await writeFile(path.join(directory, "accept.json"), JSON.stringify(acceptance));
    const journal = await readFile(path.join(directory, "journal.jsonl"), "utf8");
    await writeFile(path.join(directory, "journal.jsonl"), journal.replace('"sequence":2', '"sequence":4'));
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow("sequence");
  });

  it("releases a stopped setup only with explicit no-invocation and correlated error evidence", async () => {
    await metadata({ exitCode: 1, nativeInvoked: false });
    await completion();
    await rm(path.join(directory, "native-result.json"));
    const launcher = JSON.parse(await readFile(path.join(directory, "launcher-result.json"), "utf8"));
    await writeFile(path.join(directory, "launcher-result.json"), JSON.stringify({
      ...launcher, launcherExitCode: 1, bridgeExitCode: 1, scriptError: true,
      nativeExitCode: null, nativeExecutionObserved: null, errorKind: "launcher-script-error",
    }));
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "failed", reserved: false });
    await metadata({ exitCode: 1 });
    operation.startedAt = new Date(Date.now() - 180_000).toISOString();
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({ status: "unconfirmed", reserved: true });
  });

  it("rejects uncorrelated results rather than releasing the Work", async () => {
    await metadata({ exitCode: 0 });
    await completion(randomUUID());
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow("nonce");
  });

  it("surfaces corrupt state and incomplete process identity", async () => {
    await metadata({ wrapperStartTime: undefined });
    await expect(caseIqAuthenticationActivity(operation)).rejects.toThrow("identity");
    const files = await import("node:fs/promises").then((fs) => fs.readdir(caseIqAuthenticationDirectory()));
    await writeFile(path.join(caseIqAuthenticationDirectory(), files[0]), "{bad");
    await expect(readCaseIqAuthentication("work")).rejects.toThrow();
  });

  it("releases a confirmed spawn rejection and keeps its error explicit", async () => {
    operation = { ...operation, launchRejected: true, errorMessage: "Windows Terminal was not found." };
    await writeCaseIqAuthentication(operation);
    expect(await caseIqAuthenticationActivity(operation)).toMatchObject({
      status: "failed", reserved: false, message: "Windows Terminal was not found.",
    });
    expect(await caseIqAuthenticationBlockedReason(["work:work"])).toBeNull();
  });

  it("keeps late preparation errors scoped to their operation rather than replacing another request", async () => {
    await writeFile(path.join(directory, "authentication-error.json"), JSON.stringify({
      operationId: operation.id, message: "Native setup needs review.",
    }));
    expect((await caseIqAuthenticationActivity(operation)).message).toBe("Native setup needs review.");
    const replacement = { ...operation, id: randomUUID() };
    await writeCaseIqAuthentication(replacement);
    expect(JSON.parse(await readFile(path.join(directory, "authentication-error.json"), "utf8")).operationId).toBe(operation.id);
    expect((await readCaseIqAuthentication("work"))?.id).toBe(replacement.id);
  });
});
