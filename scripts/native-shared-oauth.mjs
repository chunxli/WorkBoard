import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { MAX_BRIDGE_FILE_BYTES, NativeBridgeError, nativeOAuthStorageSchema } from "./native-bridge-protocol.mjs";

class SharedOAuthUnavailable extends Error {
  constructor(reason) {
    super(`Shared OAuth cache unavailable: ${reason}.`);
    this.reason = reason;
  }
}

const filesystemFailures = new Set([
  "EACCES", "EBUSY", "EEXIST", "EINVAL", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG",
  "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "ENOTSUP", "EPERM", "EROFS", "ETIMEDOUT",
]);

export function sharedOAuthFailureReason(error) {
  if (error instanceof SharedOAuthUnavailable) return error.reason;
  if (error instanceof Error && "code" in error &&
      (filesystemFailures.has(error.code) || typeof error.code === "number" && "cmd" in error) ||
      error instanceof Error && "cmd" in error && "killed" in error && error.killed === true) {
    return "shared-directory-unavailable";
  }
  return null;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function optionalInfo(file) {
  try { return await lstat(file); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function plainDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), path.resolve(directory))) {
    throw new SharedOAuthUnavailable("unsafe-cache-path");
  }
}

export async function ensureOAuthDirectory(root, directory, secureDirectory) {
  if (!within(root, directory)) throw new SharedOAuthUnavailable("unsafe-cache-path");
  await plainDirectory(root);
  let current = root;
  for (const component of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await plainDirectory(current);
    if (secureDirectory) await secureDirectory(current);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

async function supportIqProfile(files) {
  let profile = null;
  for (const file of files) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BRIDGE_FILE_BYTES) {
      throw new SharedOAuthUnavailable("supportiq-profile-unavailable");
    }
    let configuration;
    try { configuration = JSON5.parse(await readFile(file, "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new SharedOAuthUnavailable("supportiq-profile-unavailable");
      throw error;
    }
    const server = configuration?.mcpServers?.SupportIQ;
    if (server === undefined) continue;
    if (server === null || typeof server !== "object" || Array.isArray(server) ||
        typeof server.url !== "string" || !/^https?:\/\//i.test(server.url) ||
        /\$\{|\$\(|%[A-Za-z_][A-Za-z0-9_]*%/.test(server.url) || !["http", "sse"].includes(server.type)) {
      throw new SharedOAuthUnavailable("supportiq-profile-unavailable");
    }
    const identity = Object.fromEntries(Object.entries(server)
      .filter(([key]) => !["tools", "timeout", "description", "displayName"].includes(key)));
    const value = JSON.stringify(canonicalJson(identity));
    if (profile !== null && profile !== value) throw new SharedOAuthUnavailable("supportiq-profile-unavailable");
    profile = value;
  }
  if (profile === null) throw new SharedOAuthUnavailable("supportiq-profile-unavailable");
  return createHash("sha256").update(`caseiq-shared-oauth/1\0${profile}`).digest("hex");
}

async function removeLink(file) {
  const info = await optionalInfo(file);
  if (!info) return;
  if (!info.isSymbolicLink()) throw new NativeBridgeError("oauth-storage-error", "OAuth link cleanup encountered a non-link.");
  await unlink(file);
}

async function replaceLink(file, target, originalTarget) {
  const suffix = randomUUID();
  const staged = `${file}.workboard-${suffix}`;
  const previous = `${file}.previous-${suffix}`;
  let moved = false;
  let installed = false;
  try {
    await symlink(target, staged, process.platform === "win32" ? "junction" : "dir");
    const current = await optionalInfo(file);
    if (originalTarget === null ? current !== null :
        !current?.isSymbolicLink() || await readlink(file) !== originalTarget) {
      throw new SharedOAuthUnavailable("unsafe-cache-path");
    }
    if (originalTarget !== null) { await rename(file, previous); moved = true; }
    await rename(staged, file);
    installed = true;
    if (!samePath(await realpath(file), await realpath(target))) {
      throw new SharedOAuthUnavailable("unsafe-cache-path");
    }
    if (moved) { await removeLink(previous); moved = false; }
  } catch (error) {
    try {
      if (installed) await removeLink(file);
      if (moved) { await rename(previous, file); moved = false; }
      await removeLink(staged);
    } catch (restoreError) {
      throw new NativeBridgeError("oauth-storage-error", "The original OAuth cache link could not be restored. No native task was started.",
        { cause: new AggregateError([error, restoreError]) });
    }
    throw error;
  }
}

const SHARED_BROKER_SUBDIRS = ["entra-broker-accounts", "entra-broker-cache"];

async function connectOptionalBrokerSubdir(storageRoot, sessionRoot, home, profileId, subdirName) {
  const targetDirectory = path.join(storageRoot, profileId, subdirName);
  const linkPath = path.join(home, subdirName);
  const info = await optionalInfo(linkPath);
  if (info && !info.isSymbolicLink()) return;
  const originalTarget = info ? await readlink(linkPath) : null;
  const resolvedOriginal = originalTarget === null ? null : path.resolve(home, originalTarget);
  if (resolvedOriginal !== null && !within(sessionRoot, resolvedOriginal) && !within(storageRoot, resolvedOriginal)) {
    return;
  }
  await ensureOAuthDirectory(storageRoot, targetDirectory);
  if (resolvedOriginal === null || !samePath(resolvedOriginal, targetDirectory)) {
    await replaceLink(linkPath, targetDirectory, originalTarget);
  }
}

export async function connectCaseIqSharedOAuth(storage, binding) {
  const local = (reason) => nativeOAuthStorageSchema.parse({ mode: "session", profileId: null, reason });
  if (storage.root === null) return local("shared-directory-unavailable");
  const home = await realpath(binding.home);
  const sessionRoot = await realpath(storage.sessionRoot);
  if (!within(sessionRoot, home) || samePath(sessionRoot, home) ||
      storage.boundHome !== null && !samePath(home, await realpath(storage.boundHome))) {
    throw new NativeBridgeError("protocol-error", "Shared OAuth preparation does not match the bound native Session.");
  }
  try {
    await plainDirectory(storage.sessionRoot);
    await plainDirectory(storage.root);
    const profileId = await supportIqProfile(binding.additionalMcpConfigs);
    const directory = path.join(storage.root, profileId, "mcp-oauth-config");
    const file = path.join(home, "mcp-oauth-config");
    const info = await optionalInfo(file);
    if (info && !info.isSymbolicLink()) return local("local-cache-preserved");
    const originalTarget = info ? await readlink(file) : null;
    const target = originalTarget === null ? null : path.resolve(home, originalTarget);
    if (target !== null && !within(sessionRoot, target) && !within(storage.root, target)) {
      return local("unsafe-cache-path");
    }
    await ensureOAuthDirectory(storage.root, directory);
    if (target === null || !samePath(target, directory)) await replaceLink(file, directory, originalTarget);
    if (!samePath(await realpath(file), await realpath(directory))) throw new SharedOAuthUnavailable("unsafe-cache-path");
    for (const subdir of SHARED_BROKER_SUBDIRS) {
      await connectOptionalBrokerSubdir(storage.root, sessionRoot, home, profileId, subdir);
    }
    return nativeOAuthStorageSchema.parse({ mode: "shared", profileId, reason: null });
  } catch (error) {
    const reason = sharedOAuthFailureReason(error);
    if (reason === null) throw error;
    return local(reason);
  }
}
