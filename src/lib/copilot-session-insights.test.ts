import { describe, expect, it } from "vitest";
import {
  analyzeCopilotSessionEvents,
  subtractCopilotTokenUsage,
} from "./copilot-session-insights";

describe("Copilot session insights", () => {
  it("detects aborted subagents and extracts shutdown model/token usage", () => {
    const insights = analyzeCopilotSessionEvents([
      { type: "subagent.started", agentId: "analyst-a", data: { agentDisplayName: "Analyst A" } },
      { type: "abort" },
      { type: "subagent.completed", agentId: "analyst-a", data: { cancelled: true } },
      {
        type: "session.shutdown",
        data: {
          tokenDetails: {
            input: { tokenCount: 100 },
            cache_read: { tokenCount: 900 },
            cache_write: { tokenCount: 50 },
            output: { tokenCount: 25 },
          },
          modelMetrics: {
            "gpt-main": {
              requests: { count: 2 },
              usage: {
                inputTokens: 650,
                outputTokens: 15,
                cacheReadTokens: 500,
                cacheWriteTokens: 50,
                reasoningTokens: 7,
              },
            },
            "gpt-analyst": {
              requests: { count: 1 },
              usage: {
                inputTokens: 400,
                outputTokens: 10,
                cacheReadTokens: 400,
                cacheWriteTokens: 0,
                reasoningTokens: 3,
              },
            },
          },
        },
      },
    ]);

    expect(insights.completion.aborted).toBe(true);
    expect(insights.completion.cancelledSubagents).toEqual([
      { id: "analyst-a", name: "Analyst A" },
    ]);
    expect(insights.completion.rootFinalOutput).toBeNull();
    expect(insights.usage).toMatchObject({
      inputTokens: 1050,
      outputTokens: 25,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      reasoningTokens: 10,
      models: ["gpt-main", "gpt-analyst"],
    });
  });

  it("subtracts resumed-session usage and reports only models used by this Run", () => {
    const baseline = analyzeCopilotSessionEvents([{
      type: "session.shutdown",
      data: {
        tokenDetails: { input: { tokenCount: 100 }, output: { tokenCount: 10 } },
        modelMetrics: {
          "gpt-main": { requests: { count: 1 }, usage: { inputTokens: 100, outputTokens: 10 } },
        },
      },
    }]).usage;
    const current = analyzeCopilotSessionEvents([{
      type: "session.shutdown",
      data: {
        tokenDetails: { input: { tokenCount: 250 }, output: { tokenCount: 30 } },
        modelMetrics: {
          "gpt-main": { requests: { count: 2 }, usage: { inputTokens: 200, outputTokens: 20 } },
          "gpt-new": { requests: { count: 1 }, usage: { inputTokens: 50, outputTokens: 10 } },
        },
      },
    }]).usage;

    expect(subtractCopilotTokenUsage(current, baseline)).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      models: ["gpt-main", "gpt-new"],
    });
  });
});