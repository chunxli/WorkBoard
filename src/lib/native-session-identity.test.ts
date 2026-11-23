import { describe, expect, it, vi } from "vitest";
import { nativeBindingCompatibilityKey, nativeInvocationRuntimeKey } from "./native-session-identity";

vi.mock("node:fs", () => { throw new Error("Installation identity must not load filesystem I/O."); });
vi.mock("node:fs/promises", () => { throw new Error("Installation identity must not load filesystem I/O."); });
vi.mock("@/lib/prisma", () => { throw new Error("Installation identity must not load Prisma."); });
vi.mock("@/lib/native-session-bindings", () => { throw new Error("Installation identity must not load private session storage."); });

const identity = {
  launcherPath: "C:\\CaseIQ\\caseiq.ps1",
  launcherSha256: "a".repeat(64),
  sourceCommit: "b".repeat(40),
  nativeExecutable: "C:\\Copilot\\copilot.exe",
  nativeVersion: "1.0.106",
};

describe("native installation identity compatibility", () => {
  it("uses a stable installation-location fingerprint without a version admission pin", () => {
    expect(nativeBindingCompatibilityKey(identity)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.skipIf(process.platform !== "win32")("treats Windows path casing as the same installation", () => {
    expect(nativeBindingCompatibilityKey({
      ...identity, launcherPath: identity.launcherPath.toUpperCase(), nativeExecutable: identity.nativeExecutable.toUpperCase(),
    })).toBe(nativeBindingCompatibilityKey(identity));
  });

  it("keeps installation paths distinct but permits new version observations in the same Session", () => {
    const baseline = nativeBindingCompatibilityKey(identity);
    expect(nativeBindingCompatibilityKey({ ...identity, launcherPath: "C:\\different\\caseiq.ps1" })).not.toBe(baseline);
    expect(nativeBindingCompatibilityKey({ ...identity, launcherSha256: "c".repeat(64) })).toBe(baseline);
    expect(nativeBindingCompatibilityKey({ ...identity, sourceCommit: "c".repeat(40) })).toBe(baseline);
    expect(nativeBindingCompatibilityKey({ ...identity, nativeExecutable: "C:\\different\\copilot.exe" })).not.toBe(baseline);
    expect(nativeBindingCompatibilityKey({ ...identity, nativeVersion: "1.0.107" })).toBe(baseline);
  });

  it("still detects executable changes within a single prepared invocation, not commit-only updates", () => {
    const baseline = nativeInvocationRuntimeKey(identity);
    const changedCommit = { ...identity, sourceCommit: "c".repeat(40) };
    expect(nativeInvocationRuntimeKey(changedCommit)).toBe(baseline);
    expect(nativeInvocationRuntimeKey({ ...identity, launcherSha256: "c".repeat(64) })).not.toBe(baseline);
    expect(nativeInvocationRuntimeKey({ ...identity, nativeVersion: "1.0.107" })).not.toBe(baseline);
  });
});
