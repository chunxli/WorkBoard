import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseIqMcpDefaultsDirectory, readCaseIqMcpDefaults, writeCaseIqMcpDefaults } from "./caseiq-mcp-defaults-state";
import {
  caseIqEffectiveMcpApprovals, caseIqMcpConfigurationFromDefaults, caseIqToolPermissionsDirectory,
  readCaseIqMcpConfiguration, readCaseIqMcpPermissionPolicy, writeCaseIqMcpApprovals, writeCaseIqMcpConfiguration,
} from "./caseiq-tool-permissions-state";
import { saveNativeSessionBinding } from "./native-session-bindings";

const mocks = vi.hoisted(() => ({ runs: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findMany: mocks.runs } } }));
import { discoverCaseIqMcpServers, listCaseIqMcpSessions, newCaseIqMcpConfiguration } from "./caseiq-mcp-sessions";

let root: string;
let sessionId: string;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-mcp-defaults-"));
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", root);
  sessionId = randomUUID();
  await Promise.all([mkdir(caseIqMcpDefaultsDirectory()), mkdir(caseIqToolPermissionsDirectory())]);
  mocks.runs.mockResolvedValue([]);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function ownedSession() {
  const home = path.join(root, "native", sessionId, "home");
  await mkdir(path.join(home, "session-state", sessionId), { recursive: true });
  await writeFile(path.join(home, "session-state", sessionId, "events.jsonl"), `${JSON.stringify({
    id: randomUUID(), type: "permission.requested", timestamp: new Date().toISOString(),
    data: { permissionRequest: { kind: "mcp", serverName: "safewright", toolName: "safewright-browser_snapshot" } },
  })}\n`);
  await saveNativeSessionBinding({
    bindingVersion: 1, providerId: "caseiq", sessionId, userId: "owner", workId: "work", hostname: hostname(), home,
    launcherPath: path.join(root, "caseiq.ps1"), launcherSha256: "a".repeat(64), sourceCommit: "b".repeat(40),
    nativeExecutable: process.execPath, nativeVersion: "1.0.107", workingDirectory: path.join(root, "work"),
    packs: ["platform"], caseNumber: null,
  });
  mocks.runs.mockResolvedValue([{ id: "run", workId: "work", copilotSessionId: sessionId, createdAt: new Date(),
    work: { name: "Synthetic Work", hostname: hostname() } }]);
}

describe("MCP Settings defaults and Work snapshots", () => {
  it("defaults new configurations to automatic without writing a defaults file on read", async () => {
    expect(await readCaseIqMcpDefaults("owner")).toEqual({ defaultAutoApprove: true, servers: [] });
    expect(await readdir(caseIqMcpDefaultsDirectory())).toEqual([]);
    const config = await newCaseIqMcpConfiguration("owner");
    expect(caseIqEffectiveMcpApprovals(config)).toEqual([{ serverName: "SupportIQ", approvedTools: [], autoApprove: true }]);
  });
  it("keeps per-user defaults isolated and rejects foreign/corrupt metadata", async () => {
    await writeCaseIqMcpDefaults("owner", { defaultAutoApprove: false, servers: [] });
    expect((await readCaseIqMcpDefaults("owner")).defaultAutoApprove).toBe(false);
    expect((await readCaseIqMcpDefaults("another-owner")).defaultAutoApprove).toBe(true);
    const file = path.join(caseIqMcpDefaultsDirectory(), (await readdir(caseIqMcpDefaultsDirectory()))[0]);
    const value = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...value, hostname: "another-host" }));
    await expect(readCaseIqMcpDefaults("owner")).rejects.toMatchObject({ status: 403 });
    await writeFile(file, "{bad");
    await expect(readCaseIqMcpDefaults("owner")).rejects.toThrow();
  });
  it("copies discovered MCP modes into a new snapshot without changing it after Settings edits", async () => {
    await ownedSession();
    await writeCaseIqMcpDefaults("owner", {
      defaultAutoApprove: true, servers: [{ serverName: "safewright", autoApprove: false }],
    });
    const configuration = await newCaseIqMcpConfiguration("owner");
    await writeCaseIqMcpConfiguration("owner", "work", sessionId, configuration);
    await writeCaseIqMcpDefaults("owner", { defaultAutoApprove: false, servers: [] });
    expect((await readCaseIqMcpConfiguration("owner", "work", sessionId))?.defaults).toEqual(configuration.defaults);
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([
      { serverName: "SupportIQ", approvedTools: [], autoApprove: true },
    ]);
    expect(await readCaseIqMcpConfiguration("owner", "another-work", sessionId)).toBeNull();
  });
  it("persists an empty manual opt-out instead of re-enabling an inherited automatic default", async () => {
    const configuration = caseIqMcpConfigurationFromDefaults({ defaultAutoApprove: true, servers: [] }, ["safewright"]);
    configuration.servers.push({ serverName: "safewright", approvedTools: [], autoApprove: false });
    await writeCaseIqMcpConfiguration("owner", "work", sessionId, configuration);
    expect((await readCaseIqMcpConfiguration("owner", "work", sessionId))?.servers).toEqual(configuration.servers);
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId)).toEqual([
      { serverName: "SupportIQ", approvedTools: [], autoApprove: true },
    ]);
  });
  it("retains v2 manual defaults and exact tools without rewriting legacy files", async () => {
    await writeCaseIqMcpApprovals("owner", "work", sessionId, []);
    const file = path.join(caseIqToolPermissionsDirectory(), (await readdir(caseIqToolPermissionsDirectory()))[0]);
    const legacy = JSON.stringify({ version: 2, userId: "owner", workId: "work", sessionId, hostname: hostname(),
      updatedAt: new Date().toISOString(), servers: [{ serverName: "SupportIQ", approvedTools: ["case_get"], autoApprove: false }] });
    await writeFile(file, legacy);
    const configuration = await readCaseIqMcpConfiguration("owner", "work", sessionId);
    expect(configuration?.origin).toBe("legacy");
    expect(configuration?.defaults.defaultAutoApprove).toBe(false);
    expect(await readCaseIqMcpPermissionPolicy("owner", "work", sessionId, ["safewright"])).toEqual([
      { serverName: "SupportIQ", approvedTools: ["case_get"], autoApprove: false },
    ]);
    expect(await readFile(file, "utf8")).toBe(legacy);
  });
});

describe("owned MCP session catalog", () => {
  it("queries only user-owned CaseIQ sessions on the serving host and exposes no prompt or path", async () => {
    await ownedSession();
    const index = await listCaseIqMcpSessions("owner");
    expect(mocks.runs).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ providerId: "caseiq", engine: "CASEIQ", hostname: hostname(), work: { userId: "owner" } }),
      distinct: ["copilotSessionId"],
    }));
    expect(index.sessions[0]).toMatchObject({ workName: "Synthetic Work", ready: true, sessionId });
    expect(index.sessions[0]).not.toHaveProperty("directoryPath");
    expect(index.sessions[0]).not.toHaveProperty("prompt");
    expect(await discoverCaseIqMcpServers("owner")).toEqual({ serverNames: ["SupportIQ", "safewright"], warnings: [] });
  });
  it("does not read MCP permissions through a different user's binding", async () => {
    await ownedSession();
    const index = await listCaseIqMcpSessions("another-owner");
    expect(index.sessions[0].ready).toBe(false);
    expect((await discoverCaseIqMcpServers("another-owner")).serverNames).toEqual(["SupportIQ"]);
  });
});
