import { describe, expect, it } from "vitest";
import { getRunStatusLabel, getWorkRunDisplayStatus } from "./work-run-status";

describe("getRunStatusLabel", () => {
  it("explains that an unknown result belongs to a Terminal session", () => {
    expect(getRunStatusLabel("UNKNOWN")).toBe("TERMINAL / STATUS UNKNOWN");
  });

  it("keeps existing status labels unchanged", () => {
    expect(getRunStatusLabel("SUCCESS")).toBe("SUCCESS");
    expect(getRunStatusLabel("IN_TERMINAL")).toBe("IN TERMINAL");
  });
});

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

  it("preserves an unknown external terminal state", () => {
    expect(
      getWorkRunDisplayStatus({ status: "UNKNOWN", trigger: "TERMINAL_RESUME" })
    ).toBe("UNKNOWN");
  });
});