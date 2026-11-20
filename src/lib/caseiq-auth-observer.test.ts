import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectSupportIqConnection, inspectSupportIqOAuth } from "../../scripts/caseiq-auth-observer.mjs";
import { trustAuthenticationWorkFolder } from "../../scripts/caseiq-native-delegate.mjs";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "workboard-auth-options-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("exact scoped trust and native MCP verification", () => {
  it("accepts native JSONC settings only for explicitly selected exact-folder trust", async () => {
    const work = path.join(root, "jsonc-work");
    const home = path.join(root, "jsonc-home");
    await Promise.all([mkdir(work), mkdir(home)]);
    const file = path.join(home, "config.json");
    const content = '// Native configuration supports comments.\n{"trustedFolders": [], "preference": "keep",}\n';
    await writeFile(file, content);
    const sessionId = randomUUID();
    const binding = { home, workingDirectory: work, sessionId };
    const request = { trustWorkFolder: false, authenticationOnly: true, mode: "terminal", resume: true, sessionId, workingDirectory: work };
    await trustAuthenticationWorkFolder(request, binding);
    expect(await readFile(file, "utf8")).toBe(content);
    await trustAuthenticationWorkFolder({ ...request, trustWorkFolder: true }, binding);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ trustedFolders: [work], preference: "keep" });
  });

  it("adds only the explicitly approved bound Work directory, preserving existing config", async () => {
    const work = path.join(root, "work");
    const home = path.join(root, "home");
    await Promise.all([mkdir(work), mkdir(home)]);
    const file = path.join(home, "config.json");
    const original = { trustedFolders: [path.join(root, "previous")], banner: "never", userPreference: "unchanged" };
    await writeFile(file, JSON.stringify(original));
    const sessionId = randomUUID();
    const binding = { home, workingDirectory: work, sessionId };
    const request = { trustWorkFolder: true, authenticationOnly: true, mode: "terminal", resume: true, sessionId, workingDirectory: work };
    await trustAuthenticationWorkFolder(request, binding);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...original, trustedFolders: [...original.trustedFolders, work] });
    await trustAuthenticationWorkFolder(request, binding);
    expect(JSON.parse(await readFile(file, "utf8")).trustedFolders).toHaveLength(2);
    await expect(trustAuthenticationWorkFolder({ ...request, authenticationOnly: false }, binding)).rejects.toThrow("trust");
    await expect(trustAuthenticationWorkFolder({ ...request, sessionId: randomUUID() }, binding)).rejects.toThrow("trust");
  });

  it("does not modify trust when the option was not selected", async () => {
    await expect(trustAuthenticationWorkFolder({ trustWorkFolder: false }, {})).resolves.toBeUndefined();
  });

  it("requires actual native connection and live tools/list, not merely cached tools", async () => {
    const list = vi.fn().mockResolvedValue({ servers: [{ name: "SupportIQ", status: "connected" }] });
    const listTools = vi.fn().mockResolvedValue({ tools: [{ name: "synthetic-tool" }] });
    const session = { rpc: { mcp: { list, listTools } } };
    expect(await inspectSupportIqConnection(session)).toEqual({ status: "connected", toolCount: 1 });
    expect(listTools).toHaveBeenCalledWith({ serverName: "SupportIQ" });
    expect(list).toHaveBeenCalledTimes(2);
    list.mockResolvedValue({ servers: [{ name: "SupportIQ", status: "needs-auth" }] });
    listTools.mockClear();
    expect(await inspectSupportIqConnection(session)).toEqual({ status: "needs-auth", toolCount: null });
    expect(listTools).not.toHaveBeenCalled();
  });

  it("does not report a disconnected or empty-tool server as verified", async () => {
    const list = vi.fn().mockResolvedValueOnce({ servers: [{ name: "SupportIQ", status: "connected" }] })
      .mockResolvedValueOnce({ servers: [{ name: "SupportIQ", status: "failed" }] });
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    expect(await inspectSupportIqConnection({ rpc: { mcp: { list, listTools } } })).toEqual({ status: "unknown", toolCount: null });
  });

  it("surfaces native API errors to the observer's explicit unknown/error receipt", async () => {
    const session = { rpc: { mcp: { list: vi.fn().mockRejectedValue(new Error("synthetic RPC unavailable")), listTools: vi.fn() } } };
    await expect(inspectSupportIqConnection(session)).rejects.toThrow("RPC unavailable");
  });

  it("uses only the passive native OAuth probe and never returns headers, bodies or tokens", async () => {
    const probe = vi.fn().mockResolvedValue({
      status: "needs-auth", reason: "initial",
      httpResponse: { statusCode: 401, headers: [{ name: "private", value: "private-detail" }], body: "private-body" },
    });
    const login = vi.fn();
    const result = await inspectSupportIqOAuth({ rpc: { mcp: { oauth: { probe, login } } } });
    expect(result).toEqual({ status: "needs-auth", reason: "initial", httpStatus: 401, errorKind: null });
    expect(probe).toHaveBeenCalledExactlyOnceWith({ serverName: "SupportIQ" });
    expect(login).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each(["authenticated", "no-auth-required", "failed"])("preserves the distinct passive OAuth outcome %s", async (status) => {
    const probe = vi.fn().mockResolvedValue({ status, httpResponse: { statusCode: 200 } });
    expect(await inspectSupportIqOAuth({ rpc: { mcp: { oauth: { probe } } } })).toEqual({
      status, reason: null, httpStatus: 200, errorKind: status === "failed" ? "native-oauth-probe-failed" : null,
    });
  });

  it("does not mistake an unavailable native probe for authenticated state", async () => {
    expect(await inspectSupportIqOAuth({ rpc: { mcp: {} } })).toMatchObject({
      status: "unknown", errorKind: "native-oauth-probe-unsupported",
    });
    const probe = vi.fn().mockRejectedValue(Object.assign(new Error("private-detail"), { code: -32601 }));
    expect(await inspectSupportIqOAuth({ rpc: { mcp: { oauth: { probe } } } })).toMatchObject({
      status: "unknown", errorKind: "native-oauth-probe-unsupported",
    });
  });

  it.each([
    ["Failed to refresh cached token: private-detail", "native-oauth-refresh-failed"],
    ["Network fetch failed: private-detail", "native-oauth-network-error"],
    ["Credential store unavailable: private-detail", "native-oauth-cache-unavailable"],
    ["Microsoft Entra requires a client ID: private-detail", "native-oauth-client-configuration"],
  ])("exposes only the error category for %s", async (message, errorKind) => {
    const probe = vi.fn().mockResolvedValue({ status: "failed", error: message });
    const result = await inspectSupportIqOAuth({ rpc: { mcp: { oauth: { probe } } } });
    expect(result.errorKind).toBe(errorKind);
    expect(JSON.stringify(result)).not.toContain("private-detail");
  });
});
