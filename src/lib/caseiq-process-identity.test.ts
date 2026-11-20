import { describe, expect, it } from "vitest";
import { readWindowsProcessStartTime, WINDOWS_PROCESS_START_TIME, windowsProcessMatchesStartTime } from "./copilot-process";

describe("CaseIQ wrapper identity input", () => {
  it("keeps precise process creation tokens as validated strings", () => {
    expect(WINDOWS_PROCESS_START_TIME.test("134384239590492155")).toBe(true);
    for (const token of ["0", "", "-1", "1.5", "1;exit", "99999999999999999999"]) {
      expect(WINDOWS_PROCESS_START_TIME.test(token)).toBe(false);
    }
  });

  it("rejects invalid process IDs and creation tokens before an OS query", async () => {
    for (const pid of [0, -1, 1.5, 0x8000_0000]) {
      await expect(readWindowsProcessStartTime(pid)).rejects.toThrow("process ID");
    }
    await expect(windowsProcessMatchesStartTime(process.pid, "invalid")).rejects.toThrow("creation identity");
  });
});

describe.skipIf(process.platform !== "win32")("Windows wrapper creation identity", () => {
  it("recognizes the same live process without rounding the creation token", async () => {
    const token = await readWindowsProcessStartTime(process.pid);
    expect(token).toMatch(WINDOWS_PROCESS_START_TIME);
    if (token === null) throw new Error("The current test process was not found.");
    await expect(windowsProcessMatchesStartTime(process.pid, token)).resolves.toBe(true);
  });

  it("does not mistake a different start identity for the same live PID", async () => {
    await expect(windowsProcessMatchesStartTime(process.pid, "1")).resolves.toBe(false);
  });

  it("reports an absent PID as missing rather than substituting another process", async () => {
    await expect(readWindowsProcessStartTime(0x7fff_ffff)).resolves.toBeNull();
    await expect(windowsProcessMatchesStartTime(0x7fff_ffff, "1")).resolves.toBe(false);
  });
});
