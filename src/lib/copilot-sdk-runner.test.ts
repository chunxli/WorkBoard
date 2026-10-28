import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { approveAll, type CopilotSession, type PermissionRequest } from "@github/copilot-sdk";
import {
  buildManagedSessionConfig,
  cancelSdkRun,
  createManagedRuntimeConnection,
  getCopilotCliPermissionArgs,
  openCopilotSdkSession,
} from "./copilot-sdk-runner";
import {
  ManagedSessionController,
  registerManagedSessionController,
  unregisterManagedSessionController,
} from "./managed-session-controller";

describe("openCopilotSdkSession", () => {
  it("creates the first session and resumes Follow Up sessions without pending work", async () => {
    const session = {} as CopilotSession;
    const createSession = vi.fn(async () => session);
    const resumeSession = vi.fn(async () => session);
    const client = { createSession, resumeSession };
    const config = { workingDirectory: "C:\\work", streaming: true };

    await openCopilotSdkSession(client, "session-1", config, false);
    expect(createSession).toHaveBeenCalledWith({ ...config, sessionId: "session-1" });
    expect(resumeSession).not.toHaveBeenCalled();

    await openCopilotSdkSession(client, "session-1", config, true);
    expect(resumeSession).toHaveBeenCalledWith("session-1", {
      ...config,
      continuePendingWork: false,
    });
  });
});

describe("managed runtime configuration", () => {
  it.each(["default", "full", undefined] as const)("preserves the explicit %s CLI permission scope for creation and resume", async (permissionMode) => {
    const config = buildManagedSessionConfig("cli", { workPath: "C:\\work", permissionMode });
    expect(config.onPermissionRequest).toBe(permissionMode === "full" ? approveAll : undefined);
    const client = { createSession: vi.fn(), resumeSession: vi.fn() };
    await openCopilotSdkSession(client, "permission-session", config, false);
    await openCopilotSdkSession(client, "permission-session", config, true);
    for (const received of [client.createSession.mock.calls[0][0], client.resumeSession.mock.calls[0][1]]) {
      expect(received.onPermissionRequest).toBe(config.onPermissionRequest);
    }
  });

  it.each<PermissionRequest>([
    { kind: "read", path: "C:\\synthetic\\outside-work\\evidence.txt", intention: "Read synthetic evidence" },
    { kind: "url", url: "https://example.com/", intention: "Fetch public example" },
    { kind: "mcp", serverName: "synthetic-search", toolName: "search", toolTitle: "Synthetic search", readOnly: true },
  ])("answers full-access $kind requests without an interactive Terminal", async (request) => {
    const handler = buildManagedSessionConfig("cli", { workPath: "C:\\work", permissionMode: "full" }).onPermissionRequest;
    if (!handler) throw new Error("Full-access CLI permission handler missing");
    expect(await handler(request, { sessionId: "synthetic-session" })).toEqual({ kind: "approve-once" });
  });

  it("does not bypass organization-managed approvals", async () => {
    const handler = buildManagedSessionConfig("cli", { workPath: "C:\\work", permissionMode: "full" }).onPermissionRequest;
    if (!handler) throw new Error("Full-access CLI permission handler missing");
    const request: PermissionRequest = { kind: "read", path: "C:\\synthetic\\evidence.txt", intention: "Read evidence" };
    expect(await handler({ ...request, managedApprovalRequired: true }, { sessionId: "synthetic-session" })).toEqual({ kind: "no-result" });
    expect(() => handler(request, { sessionId: "synthetic-session", managedSettingsEnabled: true }))
      .toThrow("managed settings");
  });

  it.each(["cli", "sdk"] as const)("passes configured user skill directories to %s sessions and resumes", async (runtime) => {
    const directories = ["C:\\synthetic\\SkillsCenter\\skills"];
    const config = buildManagedSessionConfig(runtime, { workPath: "C:\\work" }, directories);
    const client = { createSession: vi.fn(), resumeSession: vi.fn() };
    await openCopilotSdkSession(client, "skill-session", config, false);
    await openCopilotSdkSession(client, "skill-session", config, true);
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ skillDirectories: directories }));
    expect(client.resumeSession).toHaveBeenCalledWith("skill-session", expect.objectContaining({ skillDirectories: directories }));
  });

  it("keeps CLI permission scopes distinct and launches the installed CLI over stdio", () => {
    expect(getCopilotCliPermissionArgs("default")).toEqual(["--allow-all-tools"]);
    expect(getCopilotCliPermissionArgs("full")).toEqual(["--allow-all"]);
    expect(createManagedRuntimeConnection("cli", "default", "C:\\tools\\copilot.exe")).toMatchObject({
      kind: "stdio",
      path: "C:\\tools\\copilot.exe",
      args: ["--allow-all-tools"],
    });
    expect(createManagedRuntimeConnection("cli", "full", "C:\\tools\\copilot.exe")).toMatchObject({
      args: ["--allow-all"],
    });
  });

  it("discovers CLI project agents while preserving the SDK runtime defaults", () => {
    const cli = buildManagedSessionConfig("cli", {
      workPath: "C:\\work",
      model: "gpt-test",
      agent: "reviewer",
      contextTier: "long_context",
      reasoningEffort: "low",
    });
    expect(cli).toMatchObject({
      workingDirectory: "C:\\work",
      model: "gpt-test",
      agent: "reviewer",
      enableConfigDiscovery: true,
      contextTier: "long_context",
      reasoningEffort: "low",
      streaming: true,
    });
    expect(cli.onPermissionRequest).toBeUndefined();
    const sdk = buildManagedSessionConfig("sdk", {
      workPath: "C:\\work",
      model: "gpt-test",
      agent: "ignored-by-legacy-sdk",
      contextTier: "default",
      reasoningEffort: "low",
    });
    expect(sdk).not.toHaveProperty("enableConfigDiscovery");
    expect(sdk).not.toHaveProperty("agent");
    expect(sdk.onPermissionRequest).toBeTypeOf("function");
  });

  it("routes cancel to the active managed session controller", async () => {
    const abort = vi.fn(async () => {});
    const controller = new ManagedSessionController({
      send: vi.fn(async () => ({ messageId: "ack" })),
      abort,
    });
    const runId = `test-run-${randomUUID()}`;
    registerManagedSessionController(runId, controller);
    try {
      expect(cancelSdkRun(runId)).toBe(true);
      await controller.waitForIdle();
      expect(abort).toHaveBeenCalledOnce();
      expect(cancelSdkRun(`missing-${runId}`)).toBe(false);
    } finally {
      unregisterManagedSessionController(runId, controller);
    }
  });
});
