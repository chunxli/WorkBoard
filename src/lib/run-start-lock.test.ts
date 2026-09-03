import { describe, expect, it } from "vitest";
import { RunStartInProgressError, withRunStartLock } from "./run-start-lock";

describe("withRunStartLock", () => {
  it("rejects overlapping Work or session starts and releases after completion", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = withRunStartLock(["work:1", "session:a"], () => pending);

    await expect(
      withRunStartLock(["session:a"], async () => undefined)
    ).rejects.toBeInstanceOf(RunStartInProgressError);
    release();
    await first;
    await expect(
      withRunStartLock(["session:a"], async () => "started")
    ).resolves.toBe("started");
  });
});