import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanStaleCopilotCredentials,
  composeCredentialManagerStatus,
  extractLatestCredWriteFailureAt,
  inspectSessionCredWriteFailure,
  inspectWindowsCredentialManager,
  isStaleEligibleCopilotMcpTarget,
} from "./windows-credential-manager";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workboard-wincred-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Windows Credential Manager quota inspection and safe cleanup", () => {
  it("whitelists only generic Copilot MCP OAuth and keychain-chunk targets", () => {
    const hash64 = "a".repeat(64);
    const uuidHex = "b".repeat(32);
    expect(isStaleEligibleCopilotMcpTarget(`${hash64}.copilot-mcp-oauth`, 1)).toBe(true);
    expect(isStaleEligibleCopilotMcpTarget(`copilot-keychain-chunk.${hash64}.${uuidHex}.0`, 1)).toBe(true);
    expect(isStaleEligibleCopilotMcpTarget(`copilot-keychain-chunk.${hash64}.${uuidHex}.3`, 1)).toBe(true);

    // Never touch non-generic credentials, GitHub CLI, main Copilot CLI sign-in, Docker, or malformed names
    expect(isStaleEligibleCopilotMcpTarget(`${hash64}.copilot-mcp-oauth`, 2)).toBe(false);
    expect(isStaleEligibleCopilotMcpTarget("gh:github.com", 1)).toBe(false);
    expect(isStaleEligibleCopilotMcpTarget("https://github.com/enterprises/microsoft:user.copilot-cli", 1)).toBe(false);
    expect(isStaleEligibleCopilotMcpTarget("com.docker.desktop:docker-desktop", 1)).toBe(false);
    expect(isStaleEligibleCopilotMcpTarget("copilot-keychain-chunk.NOTHEX.0.0", 1)).toBe(false);
    expect(isStaleEligibleCopilotMcpTarget("short.copilot-mcp-oauth", 1)).toBe(false);
  });

  it("extracts the latest CredWriteW error-8 timestamp from native Copilot session logs", async () => {
    const logsDir = path.join(root, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, "process-1.log"), [
      '2026-11-25T07:45:24.251Z [WARNING] [rust:rt_sandbox_base::keychain::imp] Windows credential operation failed {"operation":"CredWriteW","stage":"chunk-write","encoded_size":6210,"chunk_count":4,"persistence":"Enterprise","native_error_code":8}',
      '2026-11-25T07:45:40.000Z [WARNING] [rust:rt_sandbox_base::keychain::imp] Windows credential operation failed {"operation":"CredReadW","native_error_code":1168}',
    ].join("\n"));
    await writeFile(path.join(logsDir, "process-2.log"), [
      '2026-11-25T08:55:07.970Z [WARNING] [rust:rt_sandbox_base::keychain::imp] Windows credential operation failed {"operation":"CredWriteW","stage":"chunk-write","encoded_size":6212,"chunk_count":4,"persistence":"Enterprise","native_error_code":8}',
    ].join("\n"));

    expect(extractLatestCredWriteFailureAt("no matching lines")).toBeNull();
    await expect(inspectSessionCredWriteFailure(root)).resolves.toBe("2026-11-25T08:55:07.970Z");
  });

  it("flags quotaExceeded when near limit or when an unresolved CredWriteW error-8 still has stale entries", async () => {
    const full = composeCredentialManagerStatus({
      metrics: { totalCount: 275, totalBytes: 399_935, staleCopilotCount: 252, staleCopilotBytes: 385_894 },
      lastWriteFailureAt: "2026-11-25T08:55:07.970Z",
    });
    expect(full).toMatchObject({
      supported: true,
      quotaExceeded: true,
      writeFailureDetected: true,
      staleCopilotCount: 252,
    });

    // Once stale entries are cleaned and quota drops well below threshold, old log lines no longer keep alarming
    const afterCleanup = composeCredentialManagerStatus({
      metrics: { totalCount: 23, totalBytes: 14_041, staleCopilotCount: 0, staleCopilotBytes: 0 },
      lastWriteFailureAt: "2026-11-25T08:55:07.970Z",
    });
    expect(afterCleanup.quotaExceeded).toBe(false);

    // Verified OAuth check after the failure clears writeFailureDetected
    const logsDir = path.join(root, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      path.join(logsDir, "process-1.log"),
      '2026-11-25T08:00:00.000Z [WARNING] Windows credential operation failed {"operation":"CredWriteW","native_error_code":8}\n',
    );
    const rechecked = await inspectWindowsCredentialManager({
      sessionHome: root,
      verifiedAt: "2026-11-25T08:05:00.000Z",
      metricsOverride: {
        totalCount: 30,
        totalBytes: 18_000,
        staleCopilotCount: 2,
        staleCopilotBytes: 4_000,
        deletedCount: 0,
        freedBytes: 0,
      },
    });
    expect(rechecked).toMatchObject({
      quotaExceeded: false,
      writeFailureDetected: false,
      lastWriteFailureAt: null,
    });
  });

  it("returns post-cleanup metrics from cleanStaleCopilotCredentials", async () => {
    const result = await cleanStaleCopilotCredentials({
      maxAgeDays: 7,
      runner: async (days) => ({
        totalCount: 23,
        totalBytes: 14_041,
        staleCopilotCount: 0,
        staleCopilotBytes: 0,
        deletedCount: 252,
        freedBytes: 385_894 + days * 0,
      }),
    });
    expect(result).toEqual({
      deletedCount: 252,
      freedBytes: 385_894,
      remainingCount: 23,
      remainingBytes: 14_041,
      remainingStaleCopilotCount: 0,
      remainingStaleCopilotBytes: 0,
      staleMaxAgeDays: 7,
    });
  });
});
