import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ link: false, install: false, restore: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: async (...args: Parameters<typeof actual.symlink>) => {
      if (faults.link) throw Object.assign(new Error("Synthetic junction failure"), { code: "EPERM" });
      return actual.symlink(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.install && String(args[0]).includes(".workboard-") ||
          faults.restore && String(args[0]).includes(".previous-")) {
        throw Object.assign(new Error("Synthetic link rename failure"), { code: "EPERM" });
      }
      return actual.rename(...args);
    },
  };
});

import { connectCaseIqSharedOAuth, ensureOAuthDirectory, sharedOAuthFailureReason } from "../../scripts/native-shared-oauth.mjs";
import { getCaseIqSharedOAuthRoot, isPrivateRuntimePath } from "./native-runtime-paths";

let root: string;
let shared: string;
const linkType = process.platform === "win32" ? "junction" : "dir";

beforeEach(async () => {
  faults.link = false; faults.install = false; faults.restore = false;
  root = await mkdtemp(path.join(tmpdir(), "workboard-shared-oauth-"));
  shared = path.join(root, "shared");
  await mkdir(shared);
  vi.stubEnv("WORKBOARD_CASEIQ_STATE_ROOT", root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function session(url = "https://supportiq.invalid/mcp") {
  const sessionRoot = path.join(root, "native", randomUUID());
  const home = path.join(sessionRoot, "home", "conversation");
  const original = path.join(sessionRoot, "home", "shared", "mcp-oauth-config");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(original, { recursive: true })]);
  const file = path.join(home, "mcp-oauth-config");
  await symlink(original, file, linkType);
  const configuration = path.join(home, "mcp-config-channel.json");
  await writeFile(configuration, JSON.stringify({
    mcpServers: { SupportIQ: { type: "http", url, tools: ["case_get"] } },
  }));
  return {
    storage: { root: shared, sessionRoot, boundHome: null as string | null },
    binding: { home, additionalMcpConfigs: [configuration] },
    file, original, configuration,
  };
}

describe("private shared CaseIQ OAuth scope", () => {
  it("uses a stable owner/host/account/installation scope, not a Work or Session directory", () => {
    const launcher = path.join(root, "installation", "caseiq.ps1");
    const first = getCaseIqSharedOAuthRoot("owner", launcher);
    expect(getCaseIqSharedOAuthRoot("owner", launcher)).toBe(first);
    expect(getCaseIqSharedOAuthRoot("another-owner", launcher)).not.toBe(first);
    expect(getCaseIqSharedOAuthRoot("owner", path.join(root, "another", "caseiq.ps1"))).not.toBe(first);
    expect(isPrivateRuntimePath(first)).toBe(true);
    expect(first).not.toContain("owner");
    expect(first).not.toContain("native");
  });
  it("separates hosts and operating-system accounts even with an explicit runtime-root override", () => {
    const launcher = path.join(root, "installation", "caseiq.ps1");
    const first = getCaseIqSharedOAuthRoot("owner", launcher);
    const host = vi.spyOn(os, "hostname").mockReturnValue("another-host");
    expect(getCaseIqSharedOAuthRoot("owner", launcher)).not.toBe(first);
    host.mockRestore();
    const account = os.userInfo();
    vi.spyOn(os, "userInfo").mockReturnValue({ ...account, username: "another-os-account" });
    expect(getCaseIqSharedOAuthRoot("owner", launcher)).not.toBe(first);
  });

  it("will not create or secure directories through a redirected parent", async () => {
    const foreign = path.join(root, "foreign");
    await mkdir(foreign);
    await symlink(foreign, path.join(shared, "redirect"), linkType);
    const secure = vi.fn();
    await expect(ensureOAuthDirectory(shared, path.join(shared, "redirect", "new"), secure)).rejects.toThrow("unsafe-cache-path");
    expect(await readdir(foreign)).toEqual([]);
    expect(secure).not.toHaveBeenCalled();
  });

  it("does not turn programming failures into successful local fallback", () => {
    expect(sharedOAuthFailureReason(new TypeError("Synthetic programming failure"))).toBeNull();
    expect(sharedOAuthFailureReason(Object.assign(new Error("Synthetic filesystem failure"), { code: "EACCES" })))
      .toBe("shared-directory-unavailable");
    expect(sharedOAuthFailureReason(Object.assign(new Error("Synthetic ACL timeout"), { cmd: "private-acl", killed: true })))
      .toBe("shared-directory-unavailable");
  });
});

describe("shared OAuth link wiring without credential migration", () => {
  it("lets a different cold Session see a synthetic marker without sharing either home or copying the old cache", async () => {
    const first = await session();
    const second = await session();
    await writeFile(path.join(first.original, "old.marker"), "old private cache");
    const a = await connectCaseIqSharedOAuth(first.storage, first.binding);
    await writeFile(path.join(first.file, "shared.marker"), "synthetic shared state, not a token");
    const b = await connectCaseIqSharedOAuth(second.storage, second.binding);
    expect(a).toMatchObject({ mode: "shared", reason: null });
    expect(b).toEqual(a);
    expect(first.binding.home).not.toBe(second.binding.home);
    expect(await realpath(first.file)).toBe(await realpath(second.file));
    expect(await readFile(path.join(second.file, "shared.marker"), "utf8")).toContain("synthetic shared state");
    expect(await readFile(path.join(first.original, "old.marker"), "utf8")).toBe("old private cache");
    expect(await readdir(second.file)).toEqual(["shared.marker"]);
    expect(await readdir(first.original)).toEqual(["old.marker"]);
  });

  it("reconnects after the original launcher resets the link during Resume", async () => {
    const current = await session();
    const first = await connectCaseIqSharedOAuth(current.storage, current.binding);
    const target = await realpath(current.file);
    await writeFile(path.join(current.file, "shared.marker"), "resumed");
    await unlink(current.file);
    await symlink(current.original, current.file, linkType);
    current.storage.boundHome = current.binding.home;
    expect(await connectCaseIqSharedOAuth(current.storage, current.binding)).toEqual(first);
    expect(await realpath(current.file)).toBe(target);
    expect(await readFile(path.join(current.file, "shared.marker"), "utf8")).toBe("resumed");
  });

  it("keeps an already-correct shared link and creates no staging leftovers", async () => {
    const current = await session();
    const first = await connectCaseIqSharedOAuth(current.storage, current.binding);
    const before = await lstat(current.file);
    expect(await connectCaseIqSharedOAuth(current.storage, current.binding)).toEqual(first);
    expect((await lstat(current.file)).ino).toBe(before.ino);
    expect((await readdir(current.binding.home)).filter((name) => name.includes(".workboard-") || name.includes(".previous-"))).toEqual([]);
  });

  it("handles two independent Sessions preparing the same shared profile concurrently", async () => {
    const sessions = await Promise.all([session(), session()]);
    const result = await Promise.all(sessions.map((current) => connectCaseIqSharedOAuth(current.storage, current.binding)));
    expect(result[0].mode).toBe("shared");
    expect(result[1]).toEqual(result[0]);
    expect(await realpath(sessions[0].file)).toBe(await realpath(sessions[1].file));
  });

  it("separates changed endpoints and authentication settings while ignoring tool allowlists and object key order", async () => {
    const first = await session();
    const second = await session("https://other.invalid/mcp");
    const third = await session();
    await writeFile(third.configuration, JSON.stringify({
      mcpServers: { SupportIQ: { tools: ["different_tool"], url: "https://supportiq.invalid/mcp", type: "http", timeout: 5000 } },
    }));
    const a = await connectCaseIqSharedOAuth(first.storage, first.binding);
    const b = await connectCaseIqSharedOAuth(second.storage, second.binding);
    const c = await connectCaseIqSharedOAuth(third.storage, third.binding);
    expect(b.profileId).not.toBe(a.profileId);
    expect(c).toEqual(a);
    await writeFile(third.configuration, JSON.stringify({
      mcpServers: { SupportIQ: { type: "http", url: "https://supportiq.invalid/mcp", oauth: { clientId: "another-profile" } } },
    }));
    const changed = await connectCaseIqSharedOAuth(third.storage, third.binding);
    expect(changed.mode).toBe("shared");
    expect(changed.profileId).not.toBe(a.profileId);
  });

  it("preserves a real legacy cache directory without reading, moving or importing its files", async () => {
    const current = await session();
    await unlink(current.file);
    await mkdir(current.file);
    await writeFile(path.join(current.file, "private.marker"), "preserve");
    expect(await connectCaseIqSharedOAuth(current.storage, current.binding))
      .toMatchObject({ mode: "session", reason: "local-cache-preserved" });
    expect((await lstat(current.file)).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(current.file, "private.marker"), "utf8")).toBe("preserve");
  });

  it("preserves an unexpected external cache link instead of reusing another identity", async () => {
    const current = await session();
    const foreign = path.join(root, "foreign");
    await mkdir(foreign);
    await unlink(current.file);
    await symlink(foreign, current.file, linkType);
    expect(await connectCaseIqSharedOAuth(current.storage, current.binding))
      .toMatchObject({ mode: "session", reason: "unsafe-cache-path" });
    expect(await realpath(current.file)).toBe(await realpath(foreign));
    expect(await readdir(foreign)).toEqual([]);
  });

  it("rejects a foreign or changed bound Session home before touching its cache", async () => {
    const current = await session();
    const other = await session();
    await expect(connectCaseIqSharedOAuth(current.storage, other.binding)).rejects.toThrow("bound native Session");
    await expect(connectCaseIqSharedOAuth({ ...current.storage, boundHome: other.binding.home }, current.binding))
      .rejects.toThrow("bound native Session");
    expect(await realpath(current.file)).toBe(await realpath(current.original));
  });

  it("falls back explicitly when shared directory preparation failed", async () => {
    const current = await session();
    expect(await connectCaseIqSharedOAuth({ ...current.storage, root: null }, current.binding))
      .toMatchObject({ mode: "session", reason: "shared-directory-unavailable" });
    expect(await realpath(current.file)).toBe(await realpath(current.original));
  });

  it("refuses a redirected shared root without changing either cache", async () => {
    const current = await session();
    const foreign = path.join(root, "foreign");
    const redirected = path.join(root, "redirected");
    await mkdir(foreign);
    await symlink(foreign, redirected, linkType);
    expect(await connectCaseIqSharedOAuth({ ...current.storage, root: redirected }, current.binding))
      .toMatchObject({ mode: "session", reason: "unsafe-cache-path" });
    expect(await readdir(foreign)).toEqual([]);
    expect(await realpath(current.file)).toBe(await realpath(current.original));
  });

  it.each(["{}", "{", '{"mcpServers":{"SupportIQ":{"type":"http","url":"${DYNAMIC_ENDPOINT}"}}}'])
    ("retains local authentication when the SupportIQ profile cannot be determined: %s", async (configuration) => {
      const current = await session();
      await writeFile(current.configuration, configuration);
      expect(await connectCaseIqSharedOAuth(current.storage, current.binding))
        .toMatchObject({ mode: "session", reason: "supportiq-profile-unavailable" });
      expect(await realpath(current.file)).toBe(await realpath(current.original));
    });

  it("retains the original link and reports junction-creation failure without staging leftovers", async () => {
    const current = await session();
    faults.link = true;
    expect(await connectCaseIqSharedOAuth(current.storage, current.binding))
      .toMatchObject({ mode: "session", reason: "shared-directory-unavailable" });
    expect(await realpath(current.file)).toBe(await realpath(current.original));
    expect((await readdir(current.binding.home)).some((name) => name.includes(".workboard-"))).toBe(false);
  });

  it("restores the original link when installing the staged shared link fails", async () => {
    const current = await session();
    const original = await readlink(current.file);
    faults.install = true;
    expect(await connectCaseIqSharedOAuth(current.storage, current.binding))
      .toMatchObject({ mode: "session", reason: "shared-directory-unavailable" });
    expect(await readlink(current.file)).toBe(original);
    expect((await readdir(current.binding.home)).filter((name) => name.includes(".workboard-") || name.includes(".previous-"))).toEqual([]);
  });

  it("stops rather than claiming local fallback if the original link cannot be restored", async () => {
    const current = await session();
    faults.install = true; faults.restore = true;
    await expect(connectCaseIqSharedOAuth(current.storage, current.binding)).rejects.toThrow("could not be restored");
  });
});
