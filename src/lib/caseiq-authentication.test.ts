import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  work: vi.fn(), run: vi.fn(), count: vi.fn(), createRun: vi.fn(), binding: vi.fn(),
  installation: vi.fn(), prepare: vi.fn(), accept: vi.fn(), spawn: vi.fn(), history: vi.fn(), session: vi.fn(), events: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  work: { findFirst: mocks.work }, run: { findFirst: mocks.run, count: mocks.count, create: mocks.createRun },
} }));
vi.mock("@/lib/caseiq-installation", () => ({ getCaseIqInstallationPaths: mocks.installation }));
vi.mock("@/lib/native-session-bindings", async (original) => ({
  ...await original<typeof import("./native-session-bindings")>(), readNativeSessionBindingSync: mocks.binding,
}));
vi.mock("@/lib/caseiq-integration", () => ({
  prepareCaseIqAuthentication: mocks.prepare, acceptCaseIqAuthentication: mocks.accept,
  ensurePrivateRuntimeDirectory: async (directory: string) => mkdir(directory, { recursive: true }),
}));
vi.mock("@/lib/terminal-resume", () => ({ spawnDetached: mocks.spawn }));
vi.mock("@/lib/copilot-session-compat", async (original) => ({
  ...await original<typeof import("./copilot-session-compat")>(),
  copilotSessionHasHistory: mocks.history, assertCopilotSessionNotInUse: mocks.session,
  readCopilotSessionSnapshot: async () => ({ events: await mocks.events(), incompleteTail: false, size: 0, modifiedAt: new Date() }),
}));
import { getCaseIqAuthenticationStatus, startCaseIqAuthentication, supportIqAuthenticationRejectedAt } from "./caseiq-authentication";
import * as authenticationState from "./caseiq-authentication-state";

let root: string;
let sessionId: string;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-auth-start-"));
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", path.join(root, "private"));
  sessionId = randomUUID();
  const binding = {
    bindingVersion: 1, providerId: "caseiq", sessionId, userId: "owner", workId: "work",
    hostname: hostname(), home: path.join(root, "native"), workingDirectory: root,
    launcherPath: path.join(root, "caseiq.ps1"), launcherSha256: "a".repeat(64), sourceCommit: "b".repeat(40),
    nativeExecutable: process.execPath, nativeVersion: "1.0.107", packs: ["platform"], caseNumber: null,
  };
  mocks.binding.mockReturnValue(binding);
  mocks.installation.mockResolvedValue(binding);
  mocks.work.mockResolvedValue({ id: "work", hostname: hostname(), status: "ACTIVE", directoryPath: root });
  mocks.run.mockResolvedValue({ id: "run", hostname: hostname(), status: "SUCCESS", engine: "CASEIQ", providerId: "caseiq", copilotSessionId: sessionId,
    startedAt: new Date(Date.now() - 120_000), finishedAt: new Date() });
  mocks.count.mockResolvedValue(0);
  mocks.history.mockResolvedValue(true);
  mocks.events.mockResolvedValue([]);
  mocks.session.mockResolvedValue(undefined);
  mocks.spawn.mockResolvedValue(10101);
  mocks.accept.mockResolvedValue(true);
  mocks.prepare.mockImplementation(async (options: { runId: string; workId: string; sessionId: string }) => {
    const directory = path.join(root, "private", "requests", options.runId);
    await mkdir(directory, { recursive: true });
    return {
      ...options, terminalFile: path.join(directory, "terminal.json"), requestFile: path.join(directory, "request.json"),
      script: path.join(root, "workboard-caseiq.ps1"), arguments: ["-RequestFile", path.join(directory, "request.json")],
      powerShellExecutable: path.join(root, "verified-pwsh.exe"), environment: { CASEIQ_HOME: path.join(root, "scoped-home") },
    };
  });
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("explicit manual CaseIQ authentication", () => {
  function authRequired(timestamp = new Date(Date.now() - 10_000).toISOString()) {
    return { id: "native-supportiq-requirement", type: "mcp.oauth_required", timestamp,
      data: { serverName: "SupportIQ" } };
  }

  it("exposes storage mode without exposing a profile digest or treating prepared sharing as verified sign-in", async () => {
    mocks.binding.mockReturnValue({
      ...mocks.binding(), oauthStorage: { mode: "shared", profileId: "c".repeat(64), reason: null },
    });
    const status = await getCaseIqAuthenticationStatus("owner", "work", "run", true);
    expect(status.oauthStorage).toEqual({ mode: "shared", reason: null });
    expect(status.authenticationVerified).toBe(false);
    expect(status.connection?.status).toBe("unknown");
    expect(JSON.stringify(status)).not.toContain("profileId");
    expect(JSON.stringify(status)).not.toContain("c".repeat(64));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("derives one stable automatic request from an owned Run's explicit native requirement", async () => {
    mocks.events.mockResolvedValue([authRequired()]);
    const first = await getCaseIqAuthenticationStatus("owner", "work", "run", true);
    const second = await getCaseIqAuthenticationStatus("owner", "work", "run", true);
    expect(first).toMatchObject({ connection: { status: "needs-auth" }, automaticSignIn: { attempted: false } });
    expect(second.automaticSignIn).toEqual(first.automaticSignIn);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toContain("workingDirectory");
  });

  it("ignores unknown state, assistant advice, another MCP and events outside the selected web Run", async () => {
    const now = new Date().toISOString();
    mocks.events.mockResolvedValue([
      { ...authRequired(), type: "assistant.message", data: { content: "Please sign in to SupportIQ." } },
      { ...authRequired(), data: { serverName: "OtherMcp" } },
      authRequired(new Date(Date.now() - 180_000).toISOString()),
      authRequired(new Date(Date.now() + 60_000).toISOString()),
    ]);
    expect((await getCaseIqAuthenticationStatus("owner", "work", "run", true)).automaticSignIn).toBeNull();
    mocks.run.mockResolvedValue({ ...await mocks.run(), finishedAt: new Date(Date.now() - 5000) });
    mocks.events.mockResolvedValue([authRequired(now)]);
    expect((await getCaseIqAuthenticationStatus("owner", "work", "run", true)).automaticSignIn).toBeNull();
    mocks.run.mockResolvedValue({ ...await mocks.run(), status: "SUCCESS", finishedAt: null });
    expect((await getCaseIqAuthenticationStatus("owner", "work", "run", true)).automaticSignIn).toBeNull();
  });

  it("defers active/queued Works and opens the existing native sign-in action once they become idle", async () => {
    mocks.events.mockResolvedValue([authRequired()]);
    mocks.count.mockResolvedValue(1);
    const waiting = await getCaseIqAuthenticationStatus("owner", "work", "run", true);
    const requirement = waiting.automaticSignIn;
    if (!requirement) throw new Error("Missing synthetic native sign-in requirement.");
    expect(waiting).toMatchObject({ available: false, automaticSignIn: { attempted: false } });
    await expect(startCaseIqAuthentication("owner", "work", "run", requirement.requestId, true, true))
      .rejects.toThrow("Runs and queued messages");
    expect(mocks.spawn).not.toHaveBeenCalled();
    mocks.count.mockResolvedValue(0);
    const opened = await startCaseIqAuthentication("owner", "work", "run", requirement.requestId, true, true);
    expect(opened).toMatchObject({ operation: { id: requirement.requestId, automatic: true, trustWorkFolder: true, reserved: true } });
    const repeated = await startCaseIqAuthentication("owner", "work", "run", requirement.requestId, true, true);
    expect(repeated.automaticSignIn?.attempted).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({ trustWorkFolder: true, sessionId });
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("rejects a fabricated automatic trigger and does not change manual sign-in behavior", async () => {
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID(), true, true)).rejects.toThrow("no longer pending");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(await startCaseIqAuthentication("owner", "work", "run", randomUUID(), true)).toMatchObject({
      operation: { reserved: true, trustWorkFolder: true },
    });
  });

  it("does not reopen the same requirement after a prior attempt or from OAuth events in the authentication window", async () => {
    const signal = authRequired(new Date(Date.now() - 30_000).toISOString());
    const id = randomUUID();
    await mkdir(authenticationState.caseIqAuthenticationDirectory(), { recursive: true });
    await authenticationState.writeCaseIqAuthentication({
      id, userId: "owner", workId: "work", sourceRunId: "run", sessionId, hostname: hostname(),
      startedAt: new Date(Date.now() - 20_000).toISOString(), launchRejected: true, errorMessage: "Synthetic previous attempt.",
      trustWorkFolder: true, automatic: true,
    });
    mocks.run.mockResolvedValue({ ...await mocks.run(), finishedAt: new Date(Date.now() - 25_000) });
    mocks.events.mockResolvedValue([signal, authRequired(new Date(Date.now() - 5000).toISOString())]);
    const value = await getCaseIqAuthenticationStatus("owner", "work", "run", true);
    expect(value.automaticSignIn).toMatchObject({ attempted: true, requiredAt: signal.timestamp });
    const requirement = value.automaticSignIn;
    if (!requirement) throw new Error("Missing original requirement.");
    await expect(startCaseIqAuthentication("owner", "work", "run", requirement.requestId, true, true)).rejects.toThrow("already handled");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("never enables automatic opening for remote or archived Work requests", async () => {
    mocks.events.mockResolvedValue([authRequired()]);
    expect((await getCaseIqAuthenticationStatus("owner", "work", "run", false)).automaticSignIn).toBeNull();
    mocks.work.mockResolvedValue({ id: "work", hostname: hostname(), status: "ARCHIVED", directoryPath: root });
    expect((await getCaseIqAuthenticationStatus("owner", "work", "run", true)).automaticSignIn).toBeNull();
  });

  it("does not open two windows for simultaneous automatic requests from separate tabs", async () => {
    mocks.events.mockResolvedValue([authRequired()]);
    const requirement = (await getCaseIqAuthenticationStatus("owner", "work", "run", true)).automaticSignIn;
    if (!requirement) throw new Error("Missing synthetic native requirement.");
    const results = await Promise.allSettled([
      startCaseIqAuthentication("owner", "work", "run", requirement.requestId, true, true),
      startCaseIqAuthentication("owner", "work", "run", requirement.requestId, true, true),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it("uses only a later native SupportIQ authentication rejection, not assistant text or old errors", () => {
    const verifiedAt = new Date(Date.now() - 60_000).toISOString();
    const rejectedAt = new Date(Date.now() - 10_000).toISOString();
    const event = { type: "tool.execution_complete", timestamp: rejectedAt,
      data: { success: false, error: { message: 'MCP server "SupportIQ" requires authentication. Sign in through your MCP client.' } } };
    expect(supportIqAuthenticationRejectedAt([event], verifiedAt)).toBe(rejectedAt);
    expect(supportIqAuthenticationRejectedAt([
      { ...event, type: "assistant.message" },
      { ...event, timestamp: new Date(Date.now() - 120_000).toISOString() },
      { ...event, data: { success: false, error: { message: 'MCP server "OtherMcp" requires authentication.' } } },
    ], verifiedAt)).toBeNull();
  });

  it("invalidates old green verification after a newer native authentication failure", async () => {
    const verifiedAt = new Date(Date.now() - 30_000).toISOString();
    const rejectedAt = new Date(Date.now() - 10_000).toISOString();
    const id = randomUUID();
    await mkdir(authenticationState.caseIqAuthenticationDirectory(), { recursive: true });
    await authenticationState.writeCaseIqAuthentication({
      id, userId: "owner", workId: "work", sourceRunId: "run", sessionId, hostname: hostname(),
      startedAt: verifiedAt, launchRejected: false, errorMessage: null, trustWorkFolder: false,
    });
    vi.spyOn(authenticationState, "caseIqAuthenticationActivity").mockResolvedValue({
      id, sourceRunId: "run", sessionId, startedAt: verifiedAt, status: "closed", reserved: false, message: "Window closed.",
    });
    vi.spyOn(authenticationState, "readCaseIqNativeConnection").mockResolvedValue({
      status: "connected", toolCount: 10, checkedAt: verifiedAt,
    });
    mocks.events.mockResolvedValue([{ type: "tool.execution_complete", timestamp: rejectedAt,
      data: { success: false, error: { message: 'MCP server "SupportIQ" requires authentication.' } } }]);
    expect(await getCaseIqAuthenticationStatus("owner", "work", "run", true)).toMatchObject({
      authenticationVerified: false, connection: { status: "needs-auth", checkedAt: rejectedAt },
    });
  });

  it("opens only the original session without a Prompt, SDK Run or permission upgrade", async () => {
    const requestId = randomUUID();
    const result = await startCaseIqAuthentication("owner", "work", "run", requestId);
    expect(result).toMatchObject({ authenticationVerified: false, operation: { id: requestId, sessionId, status: "opening", reserved: true } });
    expect(mocks.prepare).toHaveBeenCalledWith({
      userId: "owner", workId: "work", runId: requestId, sessionId, workingDirectory: root,
      trustWorkFolder: false,
    });
    expect(mocks.createRun).not.toHaveBeenCalled();
    const args: string[] = mocks.spawn.mock.calls[0][1];
    expect(args).toContain(path.join(root, "verified-pwsh.exe"));
    expect(args).not.toContain("-p");
    expect(args).not.toContain("-i");
    expect(args.join(" ")).not.toMatch(/allow-all|Bypass/);
    expect(mocks.spawn.mock.calls[0][3].CASEIQ_HOME).toBe(path.join(root, "scoped-home"));
    expect(await getCaseIqAuthenticationStatus("owner", "work", "run", true)).toMatchObject({ available: false });
  });

  it("is idempotent and rejects another request while the Work is reserved", async () => {
    const requestId = randomUUID();
    await startCaseIqAuthentication("owner", "work", "run", requestId);
    await startCaseIqAuthentication("owner", "work", "run", requestId);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("authentication");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await expect(startCaseIqAuthentication("owner", "work", "other-run", requestId)).rejects.toThrow("different Run");
  });

  it("freezes explicitly selected Work-folder trust in the idempotent request", async () => {
    const requestId = randomUUID();
    await startCaseIqAuthentication("owner", "work", "run", requestId, true);
    expect(mocks.prepare.mock.calls[0][0].trustWorkFolder).toBe(true);
    await startCaseIqAuthentication("owner", "work", "run", requestId, true);
    await expect(startCaseIqAuthentication("owner", "work", "run", requestId, false)).rejects.toThrow("different");
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it("rejects active tasks, foreign hosts, wrong engines and missing native ownership", async () => {
    mocks.count.mockResolvedValueOnce(1);
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("queued messages");
    const run = await mocks.run();
    mocks.run.mockResolvedValueOnce({ ...run, hostname: "another-host" });
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("owning Windows host");
    mocks.run.mockResolvedValueOnce({ ...run, engine: "CLI" });
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("CaseIQ web Run");
    mocks.binding.mockReturnValueOnce(null);
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("binding");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("rejects unavailable history and a different installation location before opening a window", async () => {
    mocks.history.mockResolvedValueOnce(false);
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("history");
    mocks.installation.mockResolvedValueOnce({ ...mocks.binding(), nativeExecutable: path.join(root, "unrelated.exe") });
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("installation");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not block authentication Resume after a commit, launcher or compatible CLI update", async () => {
    mocks.installation.mockResolvedValue({ ...mocks.binding(), sourceCommit: "c".repeat(40),
      launcherSha256: "d".repeat(64), nativeVersion: "2.0.0" });
    expect(await startCaseIqAuthentication("owner", "work", "run", randomUUID())).toMatchObject({
      operation: { sessionId, status: "opening", reserved: true },
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("keeps non-local and archived Work actions explicitly unavailable", async () => {
    expect(await getCaseIqAuthenticationStatus("owner", "work", "run", false)).toMatchObject({ available: false, blockedReason: expect.stringContaining("local Windows") });
    mocks.work.mockResolvedValue({ id: "work", hostname: hostname(), status: "ARCHIVED", directoryPath: root });
    expect(await getCaseIqAuthenticationStatus("owner", "work", "run", true)).toMatchObject({ available: false, blockedReason: expect.stringContaining("Restore") });
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("Restore");
  });

  it("records a confirmed spawn error instead of claiming a successful login", async () => {
    mocks.spawn.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(startCaseIqAuthentication("owner", "work", "run", randomUUID())).rejects.toThrow("ENOENT");
    const result = await getCaseIqAuthenticationStatus("owner", "work", "run", true);
    expect(result).toMatchObject({ authenticationVerified: false, operation: { status: "failed", reserved: false } });
    expect(result.operation?.message).toContain("could not be launched");
  });

  it("returns verified native evidence with exit guidance rather than asking an authenticated user to log in again", async () => {
    await startCaseIqAuthentication("owner", "work", "run", randomUUID());
    const spy = vi.spyOn(authenticationState, "readCaseIqNativeConnection").mockResolvedValue({
      status: "connected", toolCount: 10, checkedAt: new Date().toISOString(),
    });
    try {
      const result = await getCaseIqAuthenticationStatus("owner", "work", "run", true);
      expect(result).toMatchObject({ authenticationVerified: true, connection: { status: "connected", toolCount: 10 } });
      expect(result.operation?.message).toContain("Exit Copilot to release this Work");
      expect(result.blockedReason).not.toContain("run /mcp auth");
    } finally { spy.mockRestore(); }
  });
});
