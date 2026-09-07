import { describe, expect, it } from "vitest";
import { buildNewTerminalSessionArgs } from "./terminal-resume";

const options = {
  sessionId: "12345678-1234-4234-8234-123456789abc",
  workName: "Investigate issue",
  prompt: "Inspect the saved evidence",
  promptFileName: "PROMPT-2.md",
  agent: "reviewer",
  model: "gpt-test",
  contextTier: "long_context",
  reasoningEffort: "high",
  permissionMode: "full",
};

describe("new terminal Work session", () => {
  it("opens an interactive fixed session with the saved Prompt and Work settings", () => {
    const args = buildNewTerminalSessionArgs(options);

    expect(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2))
      .toEqual(["--session-id", options.sessionId]);
    expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2))
      .toEqual(["-i", options.prompt]);
    expect(args).toContain("--allow-all");
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2))
      .toEqual(["--output-format", "text"]);
    expect(args).toContain("--agent");
    expect(args).toContain("--model");
    expect(args).toContain("--context");
    expect(args).toContain("--effort");
  });

  it("uses the saved Prompt file when the text exceeds the Windows command limit", () => {
    const args = buildNewTerminalSessionArgs({
      ...options,
      prompt: "x".repeat(20_001),
      permissionMode: "default",
    });

    expect(args[args.indexOf("-i") + 1]).toBe(
      "Read PROMPT-2.md in the current directory and complete all instructions in it."
    );
    expect(args).toContain("--allow-all-tools");
    expect(args).not.toContain("--allow-all");
  });
});