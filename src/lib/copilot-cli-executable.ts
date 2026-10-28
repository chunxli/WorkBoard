import { execFileSync } from "node:child_process";

export function resolveCopilotCliExecutable(): string {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = execFileSync(resolver, ["copilot"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const candidates = result.split(/\r?\n/).map((candidate) => candidate.trim()).filter(Boolean);
  const executable = process.platform === "win32"
    ? candidates.find((candidate) => /\.(exe|com|js)$/i.test(candidate)) ??
      candidates.find((candidate) => !/\.(cmd|bat|ps1|lnk)$/i.test(candidate))
    : candidates[0];
  if (!executable) {
    throw new Error("Copilot CLI has no directly spawnable executable on PATH; install the CLI executable rather than a shell wrapper.");
  }
  return executable;
}
