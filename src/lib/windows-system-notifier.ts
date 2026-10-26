import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const responseSchema = z.object({ submitted: z.literal(true), appId: z.string(), tag: z.string().regex(/^[a-f0-9]{16}$/), icon: z.string() });

export async function sendWindowsSystemNotification(notification: {
  title: string;
  message: string;
  details?: string;
  url: string;
}): Promise<void> {
  const root = await realpath(process.cwd());
  const appId = `WorkBoard.Desktop.${createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16)}`;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = path.join(root, "scripts", "workboard-notify.ps1");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Action", "Send"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        SystemRoot: systemRoot, windir: systemRoot,
        USERPROFILE: process.env.USERPROFILE,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA,
        TEMP: process.env.TEMP, TMP: process.env.TMP,
        PATH: `${path.join(systemRoot, "System32")};${path.dirname(executable)}`,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Windows notification submission failed: ${stderr.trim() || error.message}`));
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
      } catch {
        reject(new Error("Windows notification helper did not confirm submission."));
        return;
      }
      const result = responseSchema.safeParse(body);
      if (!result.success || result.data.appId !== appId || result.data.icon !== path.join(root, "public", "workboard-notification.png")) {
        reject(new Error("Windows notification helper returned an invalid submission result."));
        return;
      }
      resolve();
    });
    child.stdin?.once("error", (error) => reject(new Error(`Cannot send the Windows notification payload: ${error.message}`)));
    child.stdin?.end(JSON.stringify({ ...notification, details: notification.details ?? "", root, appId }));
  });
}
