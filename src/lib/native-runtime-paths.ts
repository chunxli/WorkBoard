import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function getCaseIqStateRoot(): string {
  const instance = createHash("sha256").update(path.resolve(process.cwd()).toLowerCase()).digest("hex").slice(0, 12);
  const root = path.resolve(/* turbopackIgnore: true */ process.env.WORKBOARD_CASEIQ_STATE_ROOT ??
    path.join(os.homedir(), ".workboard", "caseiq", instance));
  if (contains(root, os.homedir()) || contains(root, process.cwd()) || root === path.parse(root).root) {
    throw new Error("CaseIQ runtime storage must not be a home, project, or filesystem root.");
  }
  return root;
}

export function getCaseIqSharedOAuthRoot(userId: string, launcherPath: string): string {
  const installation = path.resolve(launcherPath);
  const scope = createHash("sha256").update(JSON.stringify([
    userId, os.hostname(), os.userInfo().username,
    process.platform === "win32" ? installation.toLowerCase() : installation,
  ])).digest("hex");
  return path.join(getCaseIqStateRoot(), "shared-oauth", scope);
}

function privateRuntimePaths(): string[] {
  return [
    getCaseIqStateRoot(),
    path.join(process.cwd(), "data", "caseiq"),
    path.join(process.cwd(), "data", "terminal-launches"),
  ];
}

export function isPrivateRuntimePath(candidate: string): boolean {
  return privateRuntimePaths().some((root) => contains(path.resolve(root), path.resolve(candidate)));
}

export function overlapsPrivateRuntimePath(candidate: string): boolean {
  return privateRuntimePaths().some((root) => pathIsWithin(root, candidate) || pathIsWithin(candidate, root));
}

export function pathIsWithin(root: string, candidate: string): boolean {
  return contains(path.resolve(root), path.resolve(candidate));
}
