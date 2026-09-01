import { describe, expect, it } from "vitest";
import { formatCopilotLogLines } from "./parse-copilot-json-line";

describe("formatCopilotLogLines", () => {
  const event = JSON.stringify({
    type: "assistant.message",
    data: { content: "Completed" },
  });

  it("preserves raw JSON events in JSON mode", () => {
    expect(formatCopilotLogLines([event], "json")).toEqual([event]);
  });

  it("summarizes JSON events and preserves plain lines in readable text mode", () => {
    expect(formatCopilotLogLines([event, "plain output"], "text")).toEqual([
      "🤖 Completed",
      "plain output",
    ]);
  });
});