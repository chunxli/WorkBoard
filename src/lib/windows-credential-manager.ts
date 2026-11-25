import { execFile } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { CaseIqCredentialManagerCleanup, CaseIqCredentialManagerStatus } from "@/lib/caseiq-options";

const executeFile = promisify(execFile);

export const CREDENTIAL_STALE_MAX_AGE_DAYS = 7;
export const CREDENTIAL_QUOTA_WARNING_BYTES = 300_000;
export const CREDENTIAL_QUOTA_WARNING_COUNT = 200;
const CREDENTIAL_CACHE_TTL_MS = 15_000;
const MAX_SESSION_LOG_TAIL_BYTES = 256 * 1024;
const MAX_SCANNED_LOG_FILES = 6;

const COPILOT_CREDENTIAL_CHUNK_PATTERN = /^copilot-keychain-chunk\.[a-f0-9]+\.[a-f0-9]+\.\d+$/;
const COPILOT_MCP_OAUTH_PATTERN = /^[a-f0-9]{64}\.copilot-mcp-oauth$/;

export function isStaleEligibleCopilotMcpTarget(targetName: string, credType: number): boolean {
  return credType === 1 && (
    COPILOT_CREDENTIAL_CHUNK_PATTERN.test(targetName) ||
    COPILOT_MCP_OAUTH_PATTERN.test(targetName)
  );
}

const CRED_WRITE_QUOTA_LINE = /Windows credential operation failed[\s\S]*?"operation"\s*:\s*"CredWriteW"[\s\S]*?"native_error_code"\s*:\s*8\b/;

export function extractLatestCredWriteFailureAt(logContent: string): string | null {
  if (!logContent) return null;
  let latest: string | null = null;
  for (const line of logContent.split(/\r?\n/)) {
    if (!CRED_WRITE_QUOTA_LINE.test(line)) continue;
    const match = line.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/);
    const timestamp = match?.[1] ?? null;
    if (timestamp && (!latest || Date.parse(timestamp) >= Date.parse(latest))) {
      latest = timestamp;
    }
  }
  return latest;
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const file = await open(/* turbopackIgnore: true */ filePath, "r").catch(() => null);
  if (!file) return "";
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0) return "";
    const length = Math.min(info.size, maxBytes);
    const position = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function inspectSessionCredWriteFailure(sessionHome: string | null): Promise<string | null> {
  if (!sessionHome) return null;
  const logsDirectory = path.join(sessionHome, "logs");
  const entries = await readdir(/* turbopackIgnore: true */ logsDirectory, { withFileTypes: true }).catch(() => []);
  const logFiles: { filePath: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".log") || entry.isSymbolicLink()) continue;
    const filePath = path.join(logsDirectory, entry.name);
    const info = await lstat(/* turbopackIgnore: true */ filePath).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) {
      logFiles.push({ filePath, mtimeMs: info.mtimeMs });
    }
  }
  logFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let latest: string | null = null;
  for (const { filePath } of logFiles.slice(0, MAX_SCANNED_LOG_FILES)) {
    const detected = extractLatestCredWriteFailureAt(await readFileTail(filePath, MAX_SESSION_LOG_TAIL_BYTES));
    if (detected && (!latest || Date.parse(detected) >= Date.parse(latest))) {
      latest = detected;
    }
  }
  return latest;
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function buildCleanOrInspectPowerShell(clean: boolean, maxAgeDays: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

public class WorkBoardCredStore {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr pCredentials);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);

    private static readonly Regex ChunkPattern = new Regex(@"^copilot-keychain-chunk\\.[a-f0-9]+\\.[a-f0-9]+\\.\\d+$", RegexOptions.Compiled);
    private static readonly Regex OAuthPattern = new Regex(@"^[a-f0-9]{64}\\.copilot-mcp-oauth$", RegexOptions.Compiled);

    public static bool IsEligible(string target, uint type) {
        return type == 1 && !string.IsNullOrEmpty(target) && (ChunkPattern.IsMatch(target) || OAuthPattern.IsMatch(target));
    }

    public static long[] InspectAndMaybeClean(bool clean, int maxAgeDays) {
        var deletedInfo = new long[] { 0, 0 };
        if (clean) {
            int preCount;
            IntPtr preCreds;
            if (CredEnumerate(null, 0, out preCount, out preCreds)) {
                var targets = new List<Tuple<string, uint, uint>>();
                DateTime cutoff = DateTime.UtcNow.AddDays(-maxAgeDays);
                try {
                    for (int i = 0; i < preCount; i++) {
                        IntPtr ptr = Marshal.ReadIntPtr(preCreds, i * IntPtr.Size);
                        CREDENTIAL cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
                        if (!IsEligible(cred.TargetName, cred.Type)) continue;
                        long ft = (((long)cred.LastWritten.dwHighDateTime) << 32) | ((uint)cred.LastWritten.dwLowDateTime);
                        if (DateTime.FromFileTimeUtc(ft) < cutoff) {
                            targets.Add(Tuple.Create(cred.TargetName, cred.Type, cred.CredentialBlobSize));
                        }
                    }
                } finally {
                    CredFree(preCreds);
                }
                foreach (var item in targets) {
                    if (CredDelete(item.Item1, item.Item2, 0)) {
                        deletedInfo[0]++;
                        deletedInfo[1] += item.Item3;
                    }
                }
            }
        }

        int count;
        IntPtr pCreds;
        if (!CredEnumerate(null, 0, out count, out pCreds)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168) return new long[] { 0, 0, 0, 0, deletedInfo[0], deletedInfo[1] };
            throw new InvalidOperationException("CredEnumerate failed with Win32 error " + err);
        }
        long totalBytes = 0;
        long staleCount = 0;
        long staleBytes = 0;
        DateTime postCutoff = DateTime.UtcNow.AddDays(-maxAgeDays);
        try {
            for (int i = 0; i < count; i++) {
                IntPtr ptr = Marshal.ReadIntPtr(pCreds, i * IntPtr.Size);
                CREDENTIAL cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
                totalBytes += cred.CredentialBlobSize;
                if (!IsEligible(cred.TargetName, cred.Type)) continue;
                long ft = (((long)cred.LastWritten.dwHighDateTime) << 32) | ((uint)cred.LastWritten.dwLowDateTime);
                if (DateTime.FromFileTimeUtc(ft) < postCutoff) {
                    staleCount++;
                    staleBytes += cred.CredentialBlobSize;
                }
            }
        } finally {
            CredFree(pCreds);
        }
        return new long[] { count, totalBytes, staleCount, staleBytes, deletedInfo[0], deletedInfo[1] };
    }
}
'@
$r = [WorkBoardCredStore]::InspectAndMaybeClean($${clean ? "true" : "false"}, ${maxAgeDays})
@{
    totalCount = $r[0]
    totalBytes = $r[1]
    staleCopilotCount = $r[2]
    staleCopilotBytes = $r[3]
    deletedCount = $r[4]
    freedBytes = $r[5]
} | ConvertTo-Json -Compress
`.trim();
}

const rawMetricsSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  staleCopilotCount: z.number().int().nonnegative(),
  staleCopilotBytes: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative(),
}).strict();

export type RawCredentialMetrics = z.infer<typeof rawMetricsSchema>;

let cachedMetrics: { expiresAt: number; value: RawCredentialMetrics } | null = null;
let inflightInspect: Promise<RawCredentialMetrics> | null = null;

export function clearCredentialManagerCacheForTests() {
  cachedMetrics = null;
  inflightInspect = null;
}

async function runWindowsCredentialStore(clean: boolean, maxAgeDays = CREDENTIAL_STALE_MAX_AGE_DAYS): Promise<RawCredentialMetrics> {
  const { stdout } = await executeFile(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", buildCleanOrInspectPowerShell(clean, maxAgeDays)],
    { windowsHide: true, timeout: 15_000 },
  );
  const parsed = rawMetricsSchema.parse(JSON.parse(stdout.trim()));
  cachedMetrics = { expiresAt: Date.now() + CREDENTIAL_CACHE_TTL_MS, value: parsed };
  return parsed;
}

async function readWindowsCredentialMetrics(forceRefresh = false): Promise<RawCredentialMetrics | null> {
  if (process.platform !== "win32" || process.env.NODE_ENV === "test") return null;
  if (!forceRefresh && cachedMetrics && cachedMetrics.expiresAt > Date.now()) {
    return cachedMetrics.value;
  }
  if (!forceRefresh && inflightInspect) return inflightInspect;
  const pending = runWindowsCredentialStore(false).finally(() => {
    if (inflightInspect === pending) inflightInspect = null;
  });
  inflightInspect = pending;
  return pending;
}

export function composeCredentialManagerStatus(options: {
  metrics: Pick<RawCredentialMetrics, "totalCount" | "totalBytes" | "staleCopilotCount" | "staleCopilotBytes">;
  lastWriteFailureAt: string | null;
  verifiedAfterFailure?: boolean;
  staleMaxAgeDays?: number;
}): CaseIqCredentialManagerStatus {
  const { metrics, lastWriteFailureAt, verifiedAfterFailure = false, staleMaxAgeDays = CREDENTIAL_STALE_MAX_AGE_DAYS } = options;
  const nearLimit = metrics.totalBytes >= CREDENTIAL_QUOTA_WARNING_BYTES || metrics.totalCount >= CREDENTIAL_QUOTA_WARNING_COUNT;
  const unresolvedWriteFailure = Boolean(lastWriteFailureAt && !verifiedAfterFailure && (nearLimit || metrics.staleCopilotCount > 0));
  return {
    supported: true,
    quotaExceeded: unresolvedWriteFailure || nearLimit,
    writeFailureDetected: Boolean(lastWriteFailureAt && !verifiedAfterFailure),
    lastWriteFailureAt: verifiedAfterFailure ? null : lastWriteFailureAt,
    totalCount: metrics.totalCount,
    totalBytes: metrics.totalBytes,
    staleCopilotCount: metrics.staleCopilotCount,
    staleCopilotBytes: metrics.staleCopilotBytes,
    staleMaxAgeDays,
  };
}

export async function inspectWindowsCredentialManager(options: {
  sessionHome?: string | null;
  verifiedAt?: string | null;
  forceRefresh?: boolean;
  metricsOverride?: RawCredentialMetrics | null;
} = {}): Promise<CaseIqCredentialManagerStatus | null> {
  const [metrics, rawFailureAt] = await Promise.all([
    options.metricsOverride !== undefined
      ? Promise.resolve(options.metricsOverride)
      : readWindowsCredentialMetrics(options.forceRefresh).catch(() => null),
    inspectSessionCredWriteFailure(options.sessionHome ?? null).catch(() => null),
  ]);
  if (!metrics && !rawFailureAt) return null;
  const verifiedAfterFailure = Boolean(
    rawFailureAt && options.verifiedAt && Date.parse(options.verifiedAt) > Date.parse(rawFailureAt) + 5000,
  );
  return composeCredentialManagerStatus({
    metrics: metrics ?? { totalCount: 0, totalBytes: 0, staleCopilotCount: 0, staleCopilotBytes: 0 },
    lastWriteFailureAt: rawFailureAt,
    verifiedAfterFailure,
  });
}

export async function cleanStaleCopilotCredentials(options: {
  maxAgeDays?: number;
  runner?: (maxAgeDays: number) => Promise<RawCredentialMetrics>;
} = {}): Promise<CaseIqCredentialManagerCleanup> {
  const maxAgeDays = options.maxAgeDays ?? CREDENTIAL_STALE_MAX_AGE_DAYS;
  if (!options.runner && process.platform !== "win32") {
    throw new Error("Windows Credential Manager cleanup is supported only on Windows hosts.");
  }
  const metrics = options.runner
    ? await options.runner(maxAgeDays)
    : await runWindowsCredentialStore(true, maxAgeDays);
  return {
    deletedCount: metrics.deletedCount,
    freedBytes: metrics.freedBytes,
    remainingCount: metrics.totalCount,
    remainingBytes: metrics.totalBytes,
    remainingStaleCopilotCount: metrics.staleCopilotCount,
    remainingStaleCopilotBytes: metrics.staleCopilotBytes,
    staleMaxAgeDays: maxAgeDays,
  };
}
