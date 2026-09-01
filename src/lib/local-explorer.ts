import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

export async function resolveExplorerDirectory(directoryPath: string): Promise<string> {
  const resolved = path.resolve(directoryPath.trim());
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Directory does not exist");
  return resolved;
}

export async function openDirectoryInExplorer(directoryPath: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows Explorer is only available on Windows");
  const resolved = await resolveExplorerDirectory(directoryPath);
  const child = spawn("explorer.exe", [resolved], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}