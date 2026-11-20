import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMcpToolApprovals, applySupportIqToolApprovals } from "../../scripts/caseiq-native-delegate.mjs";
import { parseNativeBridgeRequest } from "../../scripts/native-bridge-protocol.mjs";
import {
  caseIqToolPermissionsDirectory, readCaseIqToolApprovals, readCaseIqToolPermissionPolicy, requestedSupportIqTools, writeCaseIqToolApprovals,
  readCaseIqMcpPermissionPolicy, requestedMcpTools, writeCaseIqMcpApprovals,
  readCaseIqMcpConfiguration,
} from "./caseiq-tool-permissions-state";
import { CaseIqIntegrationError } from "./caseiq-errors";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), active: vi.fn(), events: vi.fn(), session: vi.fn(), initialConfiguration: vi.fn() }));
vi.mock("@/lib/caseiq-mcp-sessions", () => ({ newCaseIqMcpConfiguration: mocks.initialConfiguration }));
vi.mock("@/lib/caseiq-authentication", () => ({
  resolveCaseIqSessionOwner: mocks.owner, activeCaseIqWorkReason: mocks.active,
}));
vi.mock("@/lib/caseiq-integration", () => ({
  ensurePrivateRuntimeDirectory: async (directory: string) => mkdir(directory, { recursive: true }),
}));
vi.mock("@/lib/copilot-session-compat", async (original) => ({
  ...await original<typeof import("./copilot-session-compat")>(),
  readCompatibleCopilotSessionEvents: mocks.events, assertCopilotSessionNotInUse: mocks.session,
}));
import {
  approveCaseIqRequestedTools, getCaseIqToolPermissionStatus, setCaseIqAutomaticToolApproval, setCaseIqToolPermission,
  approveCaseIqMcpRequestedTools, getCaseIqMcpPermissionStatus, setCaseIqMcpAutomaticApproval, setCaseIqMcpToolPermission,
} from "./caseiq-tool-permissions";

let root: string;
let sessionId: string;
function permission(toolName = "SupportIQ-case_get", extra: object = {}) {
  return { type: "permission.requested", data: { permissionRequest: {
    kind: "mcp", serverName: "SupportIQ", toolName, ...extra,
  } } };
}
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-tools-"));
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", path.join(root, "private"));
  sessionId = randomUUID();
  mocks.owner.mockResolvedValue({ work: { id: "work", status: "ACTIVE" }, run: { id: "run" },
    binding: { sessionId, home: root } });
  mocks.active.mockResolvedValue(null);
  mocks.events.mockResolvedValue([permission()]);
  mocks.session.mockResolvedValue(undefined);
  mocks.initialConfiguration.mockResolvedValue({
    origin: "settings", defaults: { defaultAutoApprove: false, servers: [] }, servers: [],
  });
  await mkdir(caseIqToolPermissionsDirectory(), { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Work/session-scoped SupportIQ consent", () => {
  it("respects manual Settings defaults and reads only tool names, not customer arguments", async () => {
    const status = await getCaseIqToolPermissionStatus("owner", "work", "run", true);
    expect(status).toEqual({ sessionId, available: true, blockedReason: null, autoApproveSupportIq: false,
      tools: [{ name: "case_get", approved: false, managed: false }] });
    expect(mocks.owner).toHaveBeenCalledWith("owner", "work", "run");
    expect(requestedSupportIqTools([permission("SupportIQ-case_get", { toolArgs: { synthetic: "not displayed" } })]))
      .toEqual([{ name: "case_get", managed: false }]);
  });
  it("saves idempotent exact grants for only this owner/Work/session and supports revocation", async () => {
    expect((await setCaseIqToolPermission("owner", "work", "run", "case_get", true)).tools[0].approved).toBe(true);
    await setCaseIqToolPermission("owner", "work", "run", "case_get", true);
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual(["case_get"]);
    expect(await readCaseIqToolApprovals("owner", "another-work", sessionId)).toEqual([]);
    expect(await readCaseIqToolApprovals("owner", "work", randomUUID())).toEqual([]);
    await expect(readCaseIqToolApprovals("another-owner", "work", sessionId)).rejects.toMatchObject({ status: 403 });
    await setCaseIqToolPermission("owner", "work", "run", "case_get", false);
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual([]);
  });
  it("rejects tools never requested by this native SupportIQ session", async () => {
    await expect(setCaseIqToolPermission("owner", "work", "run", "unrequested", true)).rejects.toMatchObject({ status: 400 });
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual([]);
  });
  it.each(["*", "case_get)*", "case_get --allow-all", "OtherMCP(case_get)", "../case_get"])("rejects unrestricted or malformed patterns: %s", async (name) => {
    await expect(setCaseIqToolPermission("owner", "work", "run", name, true)).rejects.toThrow();
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual([]);
  });
  it("does not interpret another MCP or a file permission as SupportIQ consent", () => {
    expect(requestedSupportIqTools([
      permission("case_get", { serverName: "OtherMCP" }),
      permission("case_get", { kind: "read" }),
      { type: "assistant.message", data: { content: "synthetic" } },
    ])).toEqual([]);
  });
  it("does not bypass organization-managed approval", async () => {
    mocks.events.mockResolvedValue([permission("case_get", { managedApprovalRequired: true })]);
    await expect(setCaseIqToolPermission("owner", "work", "run", "case_get", true)).rejects.toMatchObject({ status: 409 });
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual([]);
  });
  it("rejects active Runs, archived Works, foreign hosts and external native sessions before granting", async () => {
    mocks.active.mockResolvedValueOnce("busy");
    await expect(setCaseIqToolPermission("owner", "work", "run", "case_get", true)).rejects.toMatchObject({ status: 409 });
    mocks.owner.mockResolvedValueOnce({ work: { id: "work", status: "ACTIVE" }, run: { id: "run" }, binding: { sessionId, home: root } })
      .mockResolvedValueOnce({ work: { id: "work", status: "ARCHIVED" }, run: { id: "run" }, binding: { sessionId, home: root } });
    await expect(setCaseIqToolPermission("owner", "work", "run", "case_get", true)).rejects.toThrow("Restore");
    expect((await getCaseIqToolPermissionStatus("owner", "work", "run", false)).available).toBe(false);
    mocks.owner.mockRejectedValueOnce(new CaseIqIntegrationError("Foreign host.", 403));
    await expect(setCaseIqToolPermission("owner", "work", "run", "case_get", true)).rejects.toMatchObject({ status: 403 });
  });
  it("does not grant a changed session after acquiring the original session lock", async () => {
    mocks.owner.mockResolvedValueOnce({ work: { status: "ACTIVE" }, run: { id: "run" }, binding: { sessionId, home: root } })
      .mockResolvedValueOnce({ work: { status: "ACTIVE" }, run: { id: "run" }, binding: { sessionId: randomUUID(), home: root } });
    await expect(setCaseIqToolPermission("owner", "work", "run", "case_get", true)).rejects.toThrow("session changed");
  });
  it("surfaces malformed or foreign private approval metadata instead of silently granting or clearing it", async () => {
    await writeCaseIqToolApprovals("owner", "work", sessionId, ["case_get"]);
    const file = path.join(caseIqToolPermissionsDirectory(), (await readdir(caseIqToolPermissionsDirectory()))[0]);
    const policy = JSON.parse(await readFile(file, "utf8"));
    expect(policy.hostname).toBe(hostname());
    await writeFile(file, JSON.stringify({ ...policy, hostname: "foreign-host" }));
    await expect(readCaseIqToolApprovals("owner", "work", sessionId)).rejects.toMatchObject({ status: 403 });
    await writeFile(file, "{bad");
    await expect(readCaseIqToolApprovals("owner", "work", sessionId)).rejects.toThrow();
  });
  it("approves only the explicit visible bulk snapshot, not another newly requested tool", async () => {
    mocks.events.mockResolvedValue([permission(), permission("get_case_emails"), permission("get_case_notes")]);
    const result = await approveCaseIqRequestedTools("owner", "work", "run", ["case_get", "get_case_emails"]);
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual(["case_get", "get_case_emails"]);
    expect(result.tools.find((tool) => tool.name === "get_case_notes")?.approved).toBe(false);
    expect(result.autoApproveSupportIq).toBe(false);
    await approveCaseIqRequestedTools("owner", "work", "run", ["case_get", "get_case_emails"]);
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toHaveLength(2);
  });
  it("rejects a whole bulk decision containing an unknown or organization-managed tool without partial approval", async () => {
    mocks.events.mockResolvedValue([permission(), permission("get_case_notes", { managedApprovalRequired: true })]);
    await expect(approveCaseIqRequestedTools("owner", "work", "run", ["case_get", "get_case_notes"])).rejects.toMatchObject({ status: 409 });
    await expect(approveCaseIqRequestedTools("owner", "work", "run", ["case_get", "unseen"])).rejects.toMatchObject({ status: 400 });
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual([]);
    await expect(approveCaseIqRequestedTools("owner", "work", "run", [])).rejects.toThrow();
    await expect(approveCaseIqRequestedTools("owner", "work", "run", ["case_get", "case_get"])).rejects.toThrow();
  });
  it("keeps automatic approval off for legacy policies and when changing individual grants", async () => {
    await writeCaseIqToolApprovals("owner", "work", sessionId, ["case_get"]);
    const file = path.join(caseIqToolPermissionsDirectory(), (await readdir(caseIqToolPermissionsDirectory()))[0]);
    const legacy = {
      version: 1, userId: "owner", workId: "work", sessionId, hostname: hostname(),
      updatedAt: new Date().toISOString(), approvedTools: ["case_get"],
    };
    await writeFile(file, JSON.stringify(legacy));
    expect(await readCaseIqToolPermissionPolicy("owner", "work", sessionId)).toEqual({ approvedTools: ["case_get"], autoApproveSupportIq: false });
    await setCaseIqToolPermission("owner", "work", "run", "case_get", false);
    expect((await readCaseIqToolPermissionPolicy("owner", "work", sessionId)).autoApproveSupportIq).toBe(false);
  });
  it("persists only this Work/session's explicit automatic option and restores individual grants when turned off", async () => {
    await setCaseIqToolPermission("owner", "work", "run", "case_get", true);
    const on = await setCaseIqAutomaticToolApproval("owner", "work", "run", true);
    expect(on.autoApproveSupportIq).toBe(true);
    expect(await readCaseIqToolPermissionPolicy("owner", "another-work", sessionId)).toEqual({ approvedTools: [], autoApproveSupportIq: false });
    expect((await readCaseIqToolPermissionPolicy("owner", "work", randomUUID())).autoApproveSupportIq).toBe(false);
    await expect(setCaseIqToolPermission("owner", "work", "run", "case_get", false)).rejects.toThrow("Turn off automatic");
    await expect(approveCaseIqRequestedTools("owner", "work", "run", ["case_get"])).rejects.toThrow("Turn off automatic");
    await setCaseIqAutomaticToolApproval("owner", "work", "run", false);
    expect(await readCaseIqToolPermissionPolicy("owner", "work", sessionId)).toEqual({ approvedTools: ["case_get"], autoApproveSupportIq: false });
  });
  it("does not change bulk or automatic settings while a Run is active", async () => {
    mocks.active.mockResolvedValue("busy");
    await expect(approveCaseIqRequestedTools("owner", "work", "run", ["case_get"])).rejects.toMatchObject({ status: 409 });
    await expect(setCaseIqAutomaticToolApproval("owner", "work", "run", true)).rejects.toMatchObject({ status: 409 });
    expect(await readCaseIqToolPermissionPolicy("owner", "work", sessionId)).toEqual({ approvedTools: [], autoApproveSupportIq: false });
  });
});

describe("generic MCP policy and legacy compatibility", () => {
  function mcp(serverName: string, toolName: string, extra: object = {}) {
    return permission(`${serverName}-${toolName}`, { serverName, ...extra });
  }
  it("discovers distinct requested MCPs and normalizes literal server prefixes without customer arguments", async () => {
    mocks.events.mockResolvedValue([permission(), mcp("safewright", "browser_snapshot"), mcp("other.server", "_read")]);
    const result = await getCaseIqMcpPermissionStatus("owner", "work", "run", true);
    expect(result.servers).toEqual([
      { serverName: "SupportIQ", autoApprove: false, tools: [{ name: "case_get", managed: false, approved: false }] },
      { serverName: "safewright", autoApprove: false, tools: [{ name: "browser_snapshot", managed: false, approved: false }] },
      { serverName: "other.server", autoApprove: false, tools: [{ name: "_read", managed: false, approved: false }] },
    ]);
  });
  it("does not grant a matching tool name or automatic approval to another MCP", async () => {
    mocks.events.mockResolvedValue([permission(), mcp("safewright", "case_get"), mcp("safewright", "browser_snapshot")]);
    await setCaseIqMcpToolPermission("owner", "work", "run", "safewright", "case_get", true);
    expect(await readCaseIqToolApprovals("owner", "work", sessionId)).toEqual([]);
    await setCaseIqMcpAutomaticApproval("owner", "work", "run", "safewright", true);
    expect((await getCaseIqToolPermissionStatus("owner", "work", "run", true)).autoApproveSupportIq).toBe(false);
    await setCaseIqMcpAutomaticApproval("owner", "work", "run", "safewright", false);
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([
      { serverName: "safewright", approvedTools: ["case_get"], autoApprove: false },
    ]);
  });
  it("approves only the chosen MCP's visible pending snapshot", async () => {
    mocks.events.mockResolvedValue([permission(), mcp("safewright", "browser_snapshot"), mcp("safewright", "browser_click")]);
    await approveCaseIqMcpRequestedTools("owner", "work", "run", "safewright", ["browser_snapshot"]);
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([
      { serverName: "safewright", approvedTools: ["browser_snapshot"], autoApprove: false },
    ]);
    await expect(setCaseIqMcpToolPermission("owner", "work", "run", "safewright", "case_get", true)).rejects.toMatchObject({ status: 400 });
  });
  it("does not allow arbitrary unobserved MCPs, even for an automatic-mode change", async () => {
    await expect(setCaseIqMcpAutomaticApproval("owner", "work", "run", "UnconfiguredMCP", true)).rejects.toMatchObject({ status: 400 });
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([]);
  });
  it.each(["shell", "SHELL", "read", "write", "url", "memory", "custom-tool", "MCP(*)", "MCP --allow-all"])("rejects unsafe native selector namespaces: %s", async (serverName) => {
    await expect(setCaseIqMcpAutomaticApproval("owner", "work", "run", serverName, true)).rejects.toThrow();
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([]);
  });
  it("surfaces an unrepresentable native MCP identifier instead of silently granting a built-in permission", () => {
    expect(() => requestedMcpTools([mcp("shell", "command")])).toThrow("cannot be safely represented");
    expect(() => requestedMcpTools([mcp("safewright", "tool(*)")])).toThrow("exact approval rule");
  });
  it("reads legacy SupportIQ policy without rewriting it, then migrates on a new explicit decision", async () => {
    await writeCaseIqToolApprovals("owner", "work", sessionId, []);
    const file = path.join(caseIqToolPermissionsDirectory(), (await readdir(caseIqToolPermissionsDirectory()))[0]);
    const legacy = JSON.stringify({ version: 1, userId: "owner", workId: "work", sessionId, hostname: hostname(),
      updatedAt: new Date().toISOString(), approvedTools: ["case_get"], autoApproveSupportIq: true });
    await writeFile(file, legacy);
    mocks.events.mockResolvedValue([permission(), mcp("safewright", "browser_snapshot")]);
    expect((await getCaseIqToolPermissionStatus("owner", "work", "run", true)).autoApproveSupportIq).toBe(true);
    expect(await readFile(file, "utf8")).toBe(legacy);
    await setCaseIqMcpToolPermission("owner", "work", "run", "safewright", "browser_snapshot", true);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3);
    expect(await readCaseIqToolPermissionPolicy("owner", "work", sessionId)).toEqual({ approvedTools: ["case_get"], autoApproveSupportIq: true });
  });
  it("preserves other MCP grants when legacy SupportIQ callers update their own policy", async () => {
    await writeCaseIqMcpApprovals("owner", "work", sessionId, [
      { serverName: "safewright", approvedTools: [], autoApprove: true },
    ]);
    await setCaseIqToolPermission("owner", "work", "run", "case_get", true);
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([
      { serverName: "SupportIQ", approvedTools: ["case_get"], autoApprove: false },
      { serverName: "safewright", approvedTools: [], autoApprove: true },
    ]);
    const legacy = await getCaseIqToolPermissionStatus("owner", "work", "run", true);
    expect(legacy).not.toHaveProperty("servers");
    expect(legacy.tools).toHaveLength(1);
  });
  it("does not bypass organization or active-run restrictions for additional MCPs", async () => {
    mocks.events.mockResolvedValue([mcp("safewright", "browser_click", { managedApprovalRequired: true })]);
    await expect(approveCaseIqMcpRequestedTools("owner", "work", "run", "safewright", ["browser_click"])).rejects.toMatchObject({ status: 409 });
    mocks.active.mockResolvedValue("busy");
    await expect(setCaseIqMcpAutomaticApproval("owner", "work", "run", "safewright", true)).rejects.toMatchObject({ status: 409 });
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([]);
  });
  it("uses automatic Settings defaults for unconfigured sessions and persists a deliberate empty manual opt-out", async () => {
    mocks.initialConfiguration.mockResolvedValue({
      origin: "settings", defaults: { defaultAutoApprove: true, servers: [{ serverName: "SupportIQ", autoApprove: true }] }, servers: [],
    });
    expect((await getCaseIqMcpPermissionStatus("owner", "work", "run", true)).servers[0].autoApprove).toBe(true);
    await setCaseIqMcpAutomaticApproval("owner", "work", "run", "SupportIQ", false);
    const stored = await readCaseIqMcpConfiguration("owner", "work", sessionId);
    expect(stored?.defaults.defaultAutoApprove).toBe(true);
    expect(stored?.servers).toEqual([{ serverName: "SupportIQ", approvedTools: [], autoApprove: false }]);
    expect((await getCaseIqMcpPermissionStatus("owner", "work", "run", true)).servers[0].autoApprove).toBe(false);
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([]);
  });
  it("does not let changed Settings rewrite a previously saved session's modes", async () => {
    await writeCaseIqToolApprovals("owner", "work", sessionId, ["case_get"], false);
    mocks.initialConfiguration.mockResolvedValue({
      origin: "settings", defaults: { defaultAutoApprove: true, servers: [] }, servers: [],
    });
    expect((await getCaseIqToolPermissionStatus("owner", "work", "run", true)).autoApproveSupportIq).toBe(false);
    expect(mocks.initialConfiguration).not.toHaveBeenCalled();
  });
});

describe("native exact-tool arguments", () => {
  function invocation() {
    return { requestFile: path.join(root, "request.json"), nativeArguments: ["-p", "synthetic", "--allow-tool", "scope-assist(get_scope_skill)"],
      home: root, launchId: randomUUID(), caseNumber: null, workingDirectory: root, instructionDirectories: [], observedVersion: "1.0.107" };
  }
  it("preserves the launcher rules and adds only the explicitly approved exact SupportIQ tool", () => {
    const original = invocation();
    const effective = applySupportIqToolApprovals({ mode: "prompt", approvedMcpTools: ["case_get"] }, original);
    expect(effective.nativeArguments).toEqual([...original.nativeArguments, "--allow-tool", "SupportIQ(case_get)"]);
    expect(original.nativeArguments).not.toContain("SupportIQ(case_get)");
    expect(effective.nativeArguments).not.toContain("--allow-all-tools");
    expect(effective.nativeArguments).not.toContain("--allow-all");
    expect(applySupportIqToolApprovals({ mode: "prompt", approvedMcpTools: ["case_get"] }, effective).nativeArguments).toEqual(effective.nativeArguments);
  });
  it("does not change ordinary unapproved or authentication invocations", () => {
    const original = invocation();
    expect(applySupportIqToolApprovals({ mode: "prompt" }, original)).toBe(original);
    expect(() => applySupportIqToolApprovals({ mode: "terminal", approvedMcpTools: ["case_get"] }, original)).toThrow("authentication");
  });
  it("adds only the fixed SupportIQ server rule when automatic approval is explicitly selected", () => {
    const original = invocation();
    const effective = applySupportIqToolApprovals({ mode: "prompt", approvedMcpTools: ["case_get"], autoApproveSupportIq: true }, original);
    expect(effective.nativeArguments).toEqual([...original.nativeArguments, "--allow-tool", "SupportIQ"]);
    expect(effective.nativeArguments).not.toContain("OtherMCP");
    expect(effective.nativeArguments.join(" ")).not.toMatch(/--allow-all|--yolo/);
    expect(applySupportIqToolApprovals({ mode: "prompt", autoApproveSupportIq: true }, effective).nativeArguments).toEqual(effective.nativeArguments);
    expect(() => applySupportIqToolApprovals({ mode: "terminal", autoApproveSupportIq: true }, original)).toThrow("authentication");
  });
  it("combines independent MCP rules without promoting exact tools or another server to automatic mode", () => {
    const original = invocation();
    const result = applyMcpToolApprovals({ mode: "prompt", mcpToolApprovals: [
      { serverName: "safewright", autoApprove: true, approvedTools: ["browser_snapshot"] },
      { serverName: "SupportIQ", autoApprove: false, approvedTools: ["case_get"] },
    ] }, original);
    expect(result.nativeArguments).toEqual([...original.nativeArguments,
      "--allow-tool", "SupportIQ(case_get)", "--allow-tool", "safewright"]);
    expect(result.nativeArguments).not.toContain("SupportIQ");
    expect(result.nativeArguments.join(" ")).not.toMatch(/--allow-all|--yolo/);
  });
  it("validates typed bridge scopes before any native process can be started", () => {
    const request = { protocolVersion: "workboard-native/1", requestId: "request", runId: "run", attemptId: "attempt",
      nonce: randomUUID(), launcherPath: path.join(root, "caseiq.ps1"), launcherSha256: "a".repeat(64),
      nativeExecutable: process.execPath, nativeVersion: "1.0.107", workingDirectory: root, sessionId, prompt: "synthetic" };
    expect(parseNativeBridgeRequest({ ...request, approvedMcpTools: ["case_get"] }).approvedMcpTools).toEqual(["case_get"]);
    expect(parseNativeBridgeRequest({ ...request, autoApproveSupportIq: true }).autoApproveSupportIq).toBe(true);
    expect(() => parseNativeBridgeRequest({ ...request, autoApproveSupportIq: "true" })).toThrow();
    expect(() => parseNativeBridgeRequest({ ...request, approvedMcpTools: ["*"] })).toThrow();
    expect(() => parseNativeBridgeRequest({ ...request, approvedMcpTools: ["case_get", "case_get"] })).toThrow();
    expect(() => parseNativeBridgeRequest({ ...request, mode: "terminal", authenticationOnly: true, resume: true,
      prompt: "", sendPrompt: false, approvedMcpTools: ["case_get"] })).toThrow("Scoped MCP");
    expect(() => parseNativeBridgeRequest({ ...request, mode: "terminal", authenticationOnly: true, resume: true,
      prompt: "", sendPrompt: false, autoApproveSupportIq: true })).toThrow("Scoped MCP");
    expect(() => parseNativeBridgeRequest({ ...request, mcpToolApprovals: [{ serverName: "shell", autoApprove: true }] })).toThrow();
    expect(() => parseNativeBridgeRequest({ ...request, mcpToolApprovals: [{ serverName: "safewright", autoApprove: true }],
      approvedMcpTools: ["case_get"] })).toThrow("cannot be mixed");
    expect(() => parseNativeBridgeRequest({ ...request, mode: "terminal", authenticationOnly: true, resume: true,
      prompt: "", sendPrompt: false, mcpToolApprovals: [{ serverName: "safewright", autoApprove: true }] })).toThrow();
  });
});
