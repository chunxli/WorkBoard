import { spawn } from "node:child_process";
import { resolveExplorerDirectory } from "@/lib/local-explorer";

export async function openDirectoryInVSCode(directoryPath: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Visual Studio Code is only available on Windows");
  const resolved = await resolveExplorerDirectory(directoryPath);
  const child = spawn("cmd.exe", ["/d", "/s", "/c", "code.cmd", resolved], {
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
