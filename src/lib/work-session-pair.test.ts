import { describe, expect, it } from "vitest";
import { readPairedFollowUpReceipt } from "./work-session-pair";

const cli = { lane: "CLI", sessionId: "e502ce2d-77f1-46f8-b9f7-af45ae1f1586",
  runId: "feb04b0e-9581-4052-84aa-60729ba8a734", queued: true } as const;
const caseIq = { lane: "CASEIQ", sessionId: "f696eb77-17e0-47aa-aa9e-d1943ffdd869",
  runId: "79454509-3587-4e8d-a5a2-fac006e06d61", queued: false } as const;

describe("paired Follow Up receipt", () => {
  it("uses the frozen destination order and preserves each Run's admission outcome", () => {
    expect(readPairedFollowUpReceipt({ runs: [caseIq, cli] }, [cli, caseIq])).toEqual({ runs: [cli, caseIq] });
  });

  it("confirms exactly one Run for a focused send", () => {
    expect(readPairedFollowUpReceipt({ runs: [caseIq] }, [caseIq])).toEqual({ runs: [caseIq] });
    expect(readPairedFollowUpReceipt({ runs: [cli, caseIq] }, [caseIq])).toBeNull();
  });

  it.each([
    ["partial", [cli]],
    ["wrong Session", [cli, { ...caseIq, sessionId: cli.sessionId }]],
    ["duplicate lane", [cli, { ...cli, runId: caseIq.runId }]],
    ["duplicate Run", [cli, { ...caseIq, runId: cli.runId }]],
    ["invalid Run ID", [cli, { ...caseIq, runId: "../work" }]],
  ])("rejects a %s response instead of reporting a confirmed send", (_, runs) => {
    expect(readPairedFollowUpReceipt({ runs }, [cli, caseIq])).toBeNull();
  });
});
