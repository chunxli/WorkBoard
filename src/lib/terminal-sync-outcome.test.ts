import { describe, expect, it } from "vitest";
import type { CopilotCompletionSummary } from "./copilot-completion";
import { resolveTerminalRunOutcome } from "./terminal-resume";

function completion(
  overrides: Partial<CopilotCompletionSummary> = {}
): CopilotCompletionSummary {
  return {
    openSubagents: [],
    cancelledSubagents: [],
    failedSubagents: [],
    openTools: [],
    rootFinalOutput: "Done",
    taskComplete: false,
    sessionIdle: true,
    aborted: false,
    ...overrides,
  };
}

describe("terminal sync outcome", () => {
  it("preserves a reported terminal exit code", () => {
    expect(resolveTerminalRunOutcome(0, completion())).toEqual({
      status: "SUCCESS",
      exitCode: 0,
      errorMessage: null,
    });
    expect(resolveTerminalRunOutcome(7, completion())).toEqual({
      status: "FAILED",
      exitCode: 7,
      errorMessage: "Copilot exited with code 7",
    });
  });

  it("recovers a complete session when the terminal did not report an exit code", () => {
    expect(resolveTerminalRunOutcome(null, completion())).toEqual({
      status: "SUCCESS",
      exitCode: null,
      errorMessage: null,
    });
    expect(resolveTerminalRunOutcome(null, completion({
      rootFinalOutput: null,
      taskComplete: true,
    }))).toMatchObject({ status: "SUCCESS", exitCode: null });
  });

  it("keeps an incomplete session unknown when the terminal did not report an exit code", () => {
    const outcome = resolveTerminalRunOutcome(null, completion({
      rootFinalOutput: null,
      openTools: [{ id: "tool-1", name: "write" }],
      sessionIdle: false,
    }));

    expect(outcome.status).toBe("UNKNOWN");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.errorMessage).toContain("Completion is unconfirmed");
  });

  it("does not infer success from an aborted response", () => {
    expect(resolveTerminalRunOutcome(null, completion({ aborted: true })).status).toBe("UNKNOWN");
  });
});