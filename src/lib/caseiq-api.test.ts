import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), work: vi.fn(), status: vi.fn(), launch: vi.fn(), local: vi.fn(),
  latest: vi.fn(), binding: vi.fn(), ready: vi.fn(), exists: vi.fn(), resume: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { findFirst: mocks.work }, run: { findFirst: mocks.latest } } }));
vi.mock("@/lib/caseiq-installation", () => ({
  getCaseIqStatus: mocks.status,
}));
vi.mock("@/lib/caseiq-errors", () => ({
  CaseIqIntegrationError: class extends Error { readonly status = 409; },
}));
vi.mock("@/lib/terminal-resume", () => ({
  launchNewWorkTerminal: mocks.launch,
  launchTerminalResume: mocks.resume,
  isTerminalResumeReady: mocks.ready,
  TerminalStartError: class extends Error { readonly status = 409; },
  TerminalResumeInProgressError: class extends Error {},
  TerminalResumeNotReadyError: class extends Error {},
}));
vi.mock("@/lib/local-terminal-policy", () => ({ localTerminalAvailable: mocks.local }));
vi.mock("@/lib/native-session-bindings", async (original) => ({
  ...await original<typeof import("./native-session-bindings")>(),
  readNativeSessionBindingSync: mocks.binding,
}));
vi.mock("@/lib/copilot-session-compat", async (original) => ({
  ...await original<typeof import("./copilot-session-compat")>(), copilotSessionHasHistory: mocks.exists,
}));

import { GET, POST } from "../app/api/works/[id]/caseiq/route";
import { POST as RESUME } from "../app/api/runs/[id]/resume-terminal/route";
import type { NativeSessionBinding } from "./native-session-bindings";
import { nativeBindingCompatibilityKey } from "./native-session-identity";

const context = { params: Promise.resolve({ id: "work" }) };
const request = (body: unknown, origin = "http://localhost") => new NextRequest("http://localhost/api/works/work/caseiq", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
});
let binding: NativeSessionBinding;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.work.mockResolvedValue({ id: "work", hostname: null, status: "ACTIVE", directoryPath: process.cwd() });
  mocks.local.mockReturnValue(true);
  mocks.status.mockResolvedValue({
    configured: true, launchable: true, reason: null, sourceCommit: "a".repeat(40), packs: [], warnings: [],
    webExecution: { supported: false, reason: "Native interaction is required", fallback: "native-terminal" },
  });
  mocks.launch.mockResolvedValue({ runId: "native-run", launcherPid: 123 });
  mocks.latest.mockResolvedValue(null);
  mocks.ready.mockResolvedValue(true);
  mocks.exists.mockResolvedValue(true);
  mocks.resume.mockResolvedValue({ runId: "caseiq-resume", launcherPid: 456 });
  binding = {
    bindingVersion: 1, providerId: "caseiq", sessionId: randomUUID(), userId: "owner", workId: "work",
    hostname: "synthetic-host", home: path.join(process.cwd(), "private-home"),
    launcherPath: path.join(process.cwd(), "caseiq.ps1"), launcherSha256: "a".repeat(64),
    sourceCommit: "b".repeat(40), nativeExecutable: process.execPath, nativeVersion: "1.0.106",
    workingDirectory: process.cwd(), packs: ["one", "two"], caseNumber: "AUTHORIZED-CASE",
  };
  mocks.binding.mockReturnValue(binding);
});

describe("CaseIQ owned native endpoint", () => {
  it("requires authentication and ownership before probing the host", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context)).status).toBe(401);
    mocks.work.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context)).status).toBe(404);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("shows a real same-provider fallback and blocks foreign-host launch", async () => {
    mocks.local.mockReturnValue(false);
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
    expect(await response.json()).toMatchObject({ launchable: false, webExecution: { supported: false, fallback: "native-terminal" } });
    expect((await POST(request({}), context)).status).toBe(403);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin calls and arbitrary executable configuration", async () => {
    expect((await POST(request({}, "https://foreign.example"), context)).status).toBe(403);
    expect((await POST(request({ root: "C:\\untrusted", command: "untrusted" }), context)).status).toBe(400);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("launches only the original CaseIQ Terminal adapter with typed options", async () => {
    const response = await POST(request({ packs: ["platform"], caseNumber: "SYNTHETIC", sendPrompt: false }), context);
    expect(response.status).toBe(202);
    expect(mocks.launch).toHaveBeenCalledWith("owner", "work", { packs: ["platform"], caseNumber: "SYNTHETIC", sendPrompt: false });
    expect(await response.json()).toMatchObject({ runId: "native-run" });
  });

  it("finds the latest CaseIQ Run independently of other providers and returns only safe settings", async () => {
    mocks.latest.mockResolvedValue({
      id: "caseiq-run", status: "SUCCESS", createdAt: new Date(), copilotSessionId: binding.sessionId, hostname: null,
    });
    const status = await mocks.status();
    mocks.status.mockResolvedValue({ ...status, compatibilityKey: nativeBindingCompatibilityKey(binding) });
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
    const result = await response.json();
    expect(result.lastSession).toMatchObject({
      runId: "caseiq-run", resumeState: "ready",
      configuration: { packs: ["one", "two"], caseNumber: "AUTHORIZED-CASE" },
    });
    expect(mocks.latest).toHaveBeenCalledWith(expect.objectContaining({
      where: { workId: "work", providerId: "caseiq", experimentVariantId: null,
        OR: [{ engine: null }, { engine: { not: "CASEIQ" } }] },
    }));
    expect(JSON.stringify(result)).not.toContain("private-home");
    expect(JSON.stringify(result)).not.toContain("launcherPath");
  });

  it.each(["version", "history", "baseline"])("explains an unavailable %s instead of offering unsafe Resume", async (reason) => {
    mocks.latest.mockResolvedValue({
      id: "caseiq-run", status: "UNKNOWN", createdAt: new Date(), copilotSessionId: binding.sessionId, hostname: null,
    });
    const status = await mocks.status();
    mocks.status.mockResolvedValue({ ...status, compatibilityKey: reason === "version" ? "f".repeat(64) : nativeBindingCompatibilityKey(binding) });
    mocks.exists.mockResolvedValue(reason !== "history");
    mocks.ready.mockResolvedValue(reason !== "baseline");
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
    expect((await response.json()).lastSession).toMatchObject({
      resumeState: "unavailable", reason: expect.any(String),
      configuration: { packs: ["one", "two"] },
    });
  });

  it("does not expose another user's private settings", async () => {
    mocks.latest.mockResolvedValue({
      id: "caseiq-run", status: "SUCCESS", createdAt: new Date(), copilotSessionId: binding.sessionId, hostname: null,
    });
    mocks.binding.mockReturnValue({ ...binding, userId: "foreign-owner" });
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
    expect((await response.json()).lastSession).toMatchObject({ resumeState: "unavailable", configuration: null });
  });

  it("reports an active native session without treating it as resumable", async () => {
    mocks.latest.mockResolvedValue({
      id: "caseiq-run", status: "RUNNING", createdAt: new Date(), copilotSessionId: binding.sessionId, hostname: null,
    });
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
    expect((await response.json()).lastSession.resumeState).toBe("active");
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it.each(["missing", "pending"])("explains %s native preparation without suggesting a duplicate launch", async (state) => {
    mocks.latest.mockResolvedValue({
      id: "caseiq-run", status: "RUNNING", createdAt: new Date(), copilotSessionId: binding.sessionId, hostname: null,
      terminalLaunches: [],
    });
    mocks.binding.mockReturnValue(state === "missing" ? null : { ...binding, home: null });
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
    expect((await response.json()).lastSession).toMatchObject({
      resumeState: "active", reason: expect.stringContaining("preparation is not yet confirmed"),
    });
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it("surfaces recorded startup/synchronization errors without leaking private diagnostic paths", async () => {
    mocks.latest.mockResolvedValue({
      id: "caseiq-run", status: "RUNNING", createdAt: new Date(), copilotSessionId: binding.sessionId, hostname: null,
      terminalLaunches: [{ errorMessage: "C:\\private-runtime\\native\\sensitive.json could not be read" }],
    });
    const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
    const value = await response.json();
    expect(value.lastSession).toMatchObject({ resumeState: "active", reason: expect.stringContaining("recorded error") });
    expect(JSON.stringify(value)).not.toContain("private-runtime");
    expect(JSON.stringify(value)).not.toContain("sensitive.json");
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it("does not suggest another launch when an active Run's binding cannot be read", async () => {
    mocks.latest.mockResolvedValue({
      id: "caseiq-run", status: "RUNNING", createdAt: new Date(), copilotSessionId: binding.sessionId, hostname: null,
    });
    mocks.binding.mockImplementation(() => { throw new Error("Unreadable C:\\private-native\\binding.json"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(new NextRequest("http://localhost/api/works/work/caseiq"), context);
      const value = await response.json();
      expect(value.lastSession).toMatchObject({ resumeState: "active", reason: expect.stringContaining("still reserves") });
      expect(JSON.stringify(value)).not.toContain("private-native");
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("rejects cross-origin Resume before looking up or opening a native session", async () => {
    const response = await RESUME(new NextRequest("http://localhost/api/runs/caseiq-run/resume-terminal", {
      method: "POST", headers: { Origin: "https://foreign.example" },
    }), { params: Promise.resolve({ id: "caseiq-run" }) });
    expect(response.status).toBe(403);
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});
