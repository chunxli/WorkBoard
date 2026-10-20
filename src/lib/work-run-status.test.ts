import { describe, expect, it } from "vitest";
import { getRunStatusLabel, getRunStatusMessage, getWorkRunDisplayStatus, TERMINAL_COMPLETION_UNCONFIRMED } from "./work-run-status";

describe("getRunStatusMessage", () => {
  it("does not assert that a terminal closed when its completion is unknown", () => {
    expect(getRunStatusMessage("UNKNOWN", "Terminal closed before reporting its exit status, and the Copilot session did not record a complete response"))
      .toBe(TERMINAL_COMPLETION_UNCONFIRMED);
  });

  it("preserves other diagnostics and absent messages", () => {
    expect(getRunStatusMessage("FAILED", "Copilot exited with code 7")).toBe("Copilot exited with code 7");
    expect(getRunStatusMessage("UNKNOWN", "Session history was truncated")).toBe("Session history was truncated");
    expect(getRunStatusMessage("RUNNING", null)).toBeNull();
  });
});

describe("getRunStatusLabel", () => {
  it("labels an unknown Terminal result without exposing the unknown state", () => {
    expect(getRunStatusLabel("UNKNOWN")).toBe("TERMINAL");
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

  it.each(["TERMINAL_START", "TERMINAL_RESUME"])("shows a stopped %s as synchronizing until settlement", (trigger) => {
    expect(getWorkRunDisplayStatus(
      { status: "RUNNING", trigger },
      { active: false, starting: false },
    )).toBe("SYNCING");
  });

  it("keeps active and starting Terminal sessions distinct from stopped ones", () => {
    for (const activity of [{ active: true, starting: false }, { active: false, starting: true }]) {
      expect(getWorkRunDisplayStatus(
        { status: "RUNNING", trigger: "TERMINAL_RESUME" }, activity,
      )).toBe("IN_TERMINAL");
    }
    expect(getWorkRunDisplayStatus(
      { status: "RUNNING", trigger: "WORK" }, { active: false, starting: false },
    )).toBe("RUNNING");
  });

  it("does not change completed outcomes or treat absent activity evidence as stopped", () => {
    expect(getWorkRunDisplayStatus(
      { status: "RUNNING", trigger: "TERMINAL_RESUME" }, null,
    )).toBe("IN_TERMINAL");
    for (const status of ["SUCCESS", "FAILED", "CANCELLED", "UNKNOWN"]) {
      expect(getWorkRunDisplayStatus(
        { status, trigger: "TERMINAL_RESUME" }, { active: false, starting: false },
      )).toBe(status);
    }
  });
});