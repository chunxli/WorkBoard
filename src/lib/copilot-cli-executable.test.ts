import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync,
}));

import { createManagedRuntimeConnection, resolveCopilotCliExecutable } from "./copilot-sdk-runner";

const originalPlatform = process.platform;

beforeEach(() => {
  execFileSync.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("Copilot executable lookup", () => {
  it("hides the Windows lookup window and selects a directly spawnable executable", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileSync.mockReturnValue("C:\\tools\\copilot.cmd\r\nC:\\Program Files\\Copilot\\copilot.exe\r\n");

    expect(resolveCopilotCliExecutable()).toBe("C:\\Program Files\\Copilot\\copilot.exe");
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith("where.exe", ["copilot"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  });

  it("preserves the non-Windows lookup command and first-match behavior", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    execFileSync.mockReturnValue("/usr/local/bin/copilot\n/usr/bin/copilot\n");

    expect(resolveCopilotCliExecutable()).toBe("/usr/local/bin/copilot");
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith("which", ["copilot"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  });

  it("still rejects Windows shell-wrapper-only installations", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileSync.mockReturnValue("C:\\tools\\copilot.cmd\r\nC:\\tools\\copilot.ps1\r\n");

    expect(resolveCopilotCliExecutable).toThrow("no directly spawnable executable on PATH");
  });

  it("propagates lookup failures rather than returning a success-shaped fallback", () => {
    const error = new Error("Copilot is not on PATH");
    execFileSync.mockImplementation(() => { throw error; });

    expect(resolveCopilotCliExecutable).toThrow(error);
  });

  it("uses the hidden lookup for CLI connections but does not resolve a CLI for SDK connections", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileSync.mockReturnValue("C:\\tools\\copilot.exe\r\n");

    expect(createManagedRuntimeConnection("cli")).toMatchObject({
      kind: "stdio",
      path: "C:\\tools\\copilot.exe",
      args: ["--allow-all-tools"],
    });
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(createManagedRuntimeConnection("sdk")).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledOnce();
  });
});
