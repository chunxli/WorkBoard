import { describe, expect, it } from "vitest";
import { getWorkRunDisplayStatus } from "./work-run-status";

describe("getWorkRunDisplayStatus", () => {
  it("distinguishes active external terminal sessions from in-app Runs", () => {
    expect(
      getWorkRunDisplayStatus({ status: "RUNNING", trigger: "TERMINAL_RESUME" })
    ).toBe("IN_TERMINAL");
    expect(
      getWorkRunDisplayStatus({ status: "RUNNING", trigger: "TERMINAL_START" })
    ).toBe("IN_TERMINAL");
    expect(getWorkRunDisplayStatus({ status: "RUNNING", trigger: "WORK" })).toBe(
      "RUNNING"
    );
  });

  it("preserves terminal completion states", () => {
    expect(
      getWorkRunDisplayStatus({ status: "SUCCESS", trigger: "TERMINAL_RESUME" })
    ).toBe("SUCCESS");
    expect(
      getWorkRunDisplayStatus({ status: "SUCCESS", trigger: "TERMINAL_START" })
    ).toBe("SUCCESS");
    expect(getWorkRunDisplayStatus(null)).toBeNull();
  });
});