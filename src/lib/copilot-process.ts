import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export class CopilotProcessStopError extends Error {
  constructor(cause: unknown) {
    super("Could not stop the native Copilot process tree.", { cause });
    this.name = "CopilotProcessStopError";
  }
}

export async function stopCopilotProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      const script = `
        $ErrorActionPreference = 'Stop'
        $processes = @(Get-CimInstance Win32_Process)
        $root = $processes | Where-Object { $_.ProcessId -eq ${pid} } | Select-Object -First 1
        if (-not $root) { exit 0 }
        $owned = [System.Collections.Generic.List[object]]::new()
        function Add-OwnedChildren([int]$parentId) {
          foreach ($item in $processes) {
            if ($item.ParentProcessId -eq $parentId -and $item.CreationDate -ge $root.CreationDate) {
              Add-OwnedChildren ([int]$item.ProcessId)
              $owned.Add($item)
            }
          }
        }
        Add-OwnedChildren ${pid}
        $owned.Add($root)
        foreach ($item in $owned) {
          $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $item.ProcessId)
          if ($current -and $current.CreationDate -eq $item.CreationDate) {
            try { Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop }
            catch {
              $remaining = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $item.ProcessId)
              if ($remaining -and $remaining.CreationDate -eq $item.CreationDate) { throw }
            }
          }
        }
      `;
      await new Promise<void>((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true, timeout: 15000 }, (error) => error ? reject(error) : resolve());
      });
      return;
    }

    const signalGroup = (signal: NodeJS.Signals | 0) => {
      try { process.kill(-pid, signal); return true; }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
      }
    };
    if (!signalGroup("SIGTERM")) return;
    const deadline = Date.now() + 5000;
    while (signalGroup(0)) {
      if (Date.now() >= deadline) { signalGroup("SIGKILL"); return; }
      await sleep(50);
    }
  } catch (error) {
    throw new CopilotProcessStopError(error);
  }
}
