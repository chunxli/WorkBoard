import { createHash } from "node:crypto";
import path from "node:path";

export interface NativeInstallationIdentity {
  launcherPath: string;
  launcherSha256: string;
  sourceCommit: string;
  nativeExecutable: string;
  nativeVersion: string;
}

export function nativeBindingCompatibilityKey(value: NativeInstallationIdentity): string {
  const normalize = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  return createHash("sha256").update(JSON.stringify([
    normalize(value.launcherPath), normalize(value.nativeExecutable),
  ])).digest("hex");
}

export function nativeInvocationRuntimeKey(value: Pick<NativeInstallationIdentity,
  "launcherPath" | "launcherSha256" | "nativeExecutable" | "nativeVersion">): string {
  const normalize = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  return createHash("sha256").update(JSON.stringify([
    normalize(value.launcherPath), value.launcherSha256,
    normalize(value.nativeExecutable), value.nativeVersion,
  ])).digest("hex");
}
