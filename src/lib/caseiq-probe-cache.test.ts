import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCaseIqStatus } from "./caseiq-installation";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-probe-"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("WORKBOARD_CASEIQ_ROOT", "");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("CaseIQ read-only probe coalescing", () => {
  it("shares only concurrent host checks, including explicit unavailable results", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => getCaseIqStatus()));
    expect(results[0]).toMatchObject({ configured: false, launchable: false, reason: expect.any(String) });
    expect(results.every((result) => result === results[0])).toBe(true);
  });

  it("does not reuse a completed unavailable check for the next manual refresh", async () => {
    const first = await getCaseIqStatus();
    const second = await getCaseIqStatus();
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ launchable: false, reason: expect.any(String) });
  });
});
