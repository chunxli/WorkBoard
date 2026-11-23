import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.execute }),
}));

import { getCaseIqPromptPowerShell } from "./caseiq-installation";
import { CaseIqIntegrationError } from "./caseiq-errors";

const host = "C:\\synthetic\\PowerShell\\pwsh.exe";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.execute.mockImplementation(async (executable: string) => ({
    stdout: executable === "where.exe" ? `${host}\r\n` : "7.6.9\r\n",
    stderr: "",
  }));
});

describe.runIf(process.platform === "win32")("CaseIQ long-path-capable PowerShell host", () => {
  it("uses a resolved, verified PowerShell 7 executable without policy bypass", async () => {
    expect(await getCaseIqPromptPowerShell()).toBe(host);
    expect(mocks.execute).toHaveBeenCalledWith("where.exe", ["pwsh.exe"], expect.any(Object));
    expect(mocks.execute).toHaveBeenCalledWith(host, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()",
    ], expect.objectContaining({ windowsHide: true, timeout: 10_000 }));
    expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain("ExecutionPolicy");
  });

  it("explicitly rejects a missing host instead of falling back to PowerShell 5", async () => {
    mocks.execute.mockRejectedValue(Object.assign(new Error("not found"), { code: 1 }));
    await expect(getCaseIqPromptPowerShell()).rejects.toThrow("PowerShell 7 (pwsh.exe) is required");
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it.each(["5.1.26100.9711", "unverified host"])("rejects incompatible version %s", async (version) => {
    mocks.execute.mockResolvedValueOnce({ stdout: host, stderr: "" })
      .mockResolvedValueOnce({ stdout: version, stderr: "" });
    await expect(getCaseIqPromptPowerShell()).rejects.toThrow("requires PowerShell 7 or newer");
  });

  it("logs a host-probe failure and preserves the public integration error", async () => {
    const error = new Error("Synthetic host access failure");
    mocks.execute.mockResolvedValueOnce({ stdout: host, stderr: "" }).mockRejectedValueOnce(error);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(getCaseIqPromptPowerShell()).rejects.toBeInstanceOf(CaseIqIntegrationError);
      expect(logged).toHaveBeenCalledWith("[CaseIQ] PowerShell host verification failed.", error);
    } finally { logged.mockRestore(); }
  });
});
