import { execFile, type ChildProcess } from "node:child_process";
import { stopOwnedProcess } from "../../scripts/owned-process.mjs";

// Windows FILETIME stays a string so its 100-nanosecond precision is not lost.
export const WINDOWS_PROCESS_START_TIME = /^[1-9]\d{0,18}$/;

export async function readWindowsProcessStartTime(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) throw new Error("Invalid Windows process ID.");
  if (process.platform !== "win32") throw new Error("Windows process identity is unavailable on this host.");
  const script = `
    $ErrorActionPreference = 'Stop'
    try { $item = [Diagnostics.Process]::GetProcessById(${pid}) }
    catch [ArgumentException] { [Console]::Write('missing'); exit 0 }
    try {
      if ($item.HasExited) { [Console]::Write('missing') }
      else { [Console]::Write($item.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)) }
    }
    catch [InvalidOperationException] {
      if ($item.HasExited) { [Console]::Write('missing') } else { throw }
    }
    finally { $item.Dispose() }
  `;
  const value = await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
  if (value === "missing") return null;
  if (!WINDOWS_PROCESS_START_TIME.test(value)) throw new Error("Windows returned an invalid process identity.");
  return value;
}

export async function windowsProcessMatchesStartTime(pid: number, expected: string): Promise<boolean> {
  if (!WINDOWS_PROCESS_START_TIME.test(expected)) throw new Error("Invalid Windows process creation identity.");
  return await readWindowsProcessStartTime(pid) === expected;
}

export class CopilotProcessStopError extends Error {
  constructor(cause: unknown) {
    super("Could not stop the native Copilot process tree.", { cause });
    this.name = "CopilotProcessStopError";
  }
}

export async function stopCopilotProcess(child: ChildProcess): Promise<void> {
  try {
    await stopOwnedProcess(child);
  } catch (error) {
    throw new CopilotProcessStopError(error);
  }
}
