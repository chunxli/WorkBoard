import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCopilotEnvironment,
  extractFinalCopilotOutput,
  getRunLogPath,
  resolveCopilotTimeoutMs,
  startCopilotRun,
} from "./copilot-runner";
import { CopilotCompletionTracker } from "./copilot-completion";
import { JobQueue } from "./job-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("Copilot process boundary", () => {
  it("supports explicitly disabling the timeout while preserving the default", () => {
    expect(resolveCopilotTimeoutMs(null)).toBeNull();
    expect(resolveCopilotTimeoutMs(undefined)).toBe(1_800_000);
    expect(resolveCopilotTimeoutMs(30)).toBe(30_000);
  });

  it("passes required tool variables but excludes Work Board service secrets", () => {
    const environment = buildCopilotEnvironment({
      NODE_ENV: "test",
      Path: "C:\\tools",
      USERPROFILE: "C:\\Users\\test",
      GH_TOKEN: "copilot-token",
      COPILOT_HOME: "C:\\Users\\test\\.copilot-custom",
      AUTH_SECRET: "auth-secret",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-secret",
      DATABASE_URL: "file:secret.db",
    });

    expect(environment.Path).toBe("C:\\tools");
    expect(environment.GH_TOKEN).toBe("copilot-token");
    expect(environment.COPILOT_HOME).toBe("C:\\Users\\test\\.copilot-custom");
    expect(environment.AUTH_SECRET).toBeUndefined();
    expect(environment.AUTH_MICROSOFT_ENTRA_ID_SECRET).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
  });

  it("extracts the final assistant message from JSONL", () => {
    const output = [
      JSON.stringify({ type: "assistant.message", data: { content: "first" } }),
      JSON.stringify({ type: "tool.execution_complete", data: {} }),
      JSON.stringify({ type: "assistant.message", data: { content: "final" } }),
    ].join("\n");
    expect(extractFinalCopilotOutput(output)).toBe("final");
  });

  it("requires a root response after all tool calls settle", () => {
    const tracker = new CopilotCompletionTracker();
    tracker.push(
      [
        JSON.stringify({ type: "assistant.message", data: { content: "Working on it" } }),
        JSON.stringify({
          type: "tool.execution_start",
          data: { toolCallId: "call-1", toolName: "task" },
        }),
        JSON.stringify({
          type: "tool.execution_complete",
          data: { toolCallId: "call-1", toolName: "task" },
        }),
      ].join("\n") + "\n"
    );

    const beforeFinalResponse = tracker.finish();
    expect(beforeFinalResponse.openTools).toEqual([]);
    expect(beforeFinalResponse.rootFinalOutput).toBeNull();

    tracker.push(
      `${JSON.stringify({ type: "assistant.message", data: { content: "Finished" } })}\n`
    );
    expect(tracker.finish().rootFinalOutput).toBe("Finished");
  });

  it("passes a stable session id and separates stdout from stderr", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "work-board-runner-"));
    cleanupPaths.push(directory);
    const script = path.join(directory, "fake-copilot.cjs");
    const stdoutPath = path.join(directory, "stdout.log");
    const stderrPath = path.join(directory, "stderr.log");
    const runId = `runner-test-${Date.now()}`;
    cleanupPaths.push(getRunLogPath(runId));
    await writeFile(
      script,
      [
        "const args = process.argv.slice(2);",
        "const index = args.indexOf('--session-id');",
        "const sessionId = index >= 0 ? args[index + 1] : null;",
        "console.log(JSON.stringify({ type: 'assistant.message', data: { content: `session:${sessionId}` } }));",
        "console.error('diagnostic');",
      ].join("\n"),
      "utf8"
    );

    const result = await startCopilotRun({
      runId,
      repoPath: directory,
      prompt: "test prompt",
      sessionId: "test-session-id",
      outputFormat: "json",
      executable: process.execPath,
      executableArgs: [script],
      trackProcessStats: false,
      stdoutLogPath: stdoutPath,
      stderrLogPath: stderrPath,
      timeoutSeconds: 30,
    });

    const stdout = await readFile(stdoutPath, "utf8");
    const stderr = await readFile(stderrPath, "utf8");
    expect(result.exitCode).toBe(0);
    expect(extractFinalCopilotOutput(stdout)).toBe("session:test-session-id");
    expect(stderr).toContain("diagnostic");
    expect(stdout).not.toContain("diagnostic");
  });

  it("resumes the same session when the CLI exits with a background sub-agent open", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "work-board-continuation-"));
    cleanupPaths.push(directory);
    const script = path.join(directory, "fake-copilot.cjs");
    const stdoutPath = path.join(directory, "stdout.log");
    const runId = `continuation-test-${Date.now()}`;
    cleanupPaths.push(getRunLogPath(runId));
    await writeFile(
      script,
      [
        "const args = process.argv.slice(2);",
        "const resumed = args.includes('--resume=test-session-id');",
        "if (resumed) {",
        "  console.log(JSON.stringify({ type: 'subagent.started', agentId: 'agent-2', data: { agentDisplayName: 'Replacement Analyst' } }));",
        "  console.log(JSON.stringify({ type: 'subagent.completed', agentId: 'agent-2', data: { agentDisplayName: 'Replacement Analyst' } }));",
        "  console.log(JSON.stringify({ type: 'assistant.message', data: { content: 'final result' } }));",
        "} else {",
        "  console.log(JSON.stringify({ type: 'subagent.started', agentId: 'agent-1', data: { agentDisplayName: 'Analyst' } }));",
        "}",
      ].join("\n"),
      "utf8"
    );

    const result = await startCopilotRun({
      runId,
      repoPath: directory,
      prompt: "test prompt",
      sessionId: "test-session-id",
      outputFormat: "json",
      executable: process.execPath,
      executableArgs: [script],
      trackProcessStats: false,
      stdoutLogPath: stdoutPath,
      timeoutSeconds: 30,
      maxIncompleteContinuations: 3,
    });

    const stdout = await readFile(stdoutPath, "utf8");
    expect(result.exitCode).toBe(0);
    expect(result.incomplete).toBe(false);
    expect(result.continuationCount).toBe(1);
    expect(result.command).toContain("--resume=test-session-id");
    expect(stdout).toContain("Resuming the same session (1/3)");
    expect(extractFinalCopilotOutput(stdout)).toBe("final result");
  });

  it("reports an incomplete result when background work remains after the continuation limit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "work-board-incomplete-"));
    cleanupPaths.push(directory);
    const script = path.join(directory, "fake-copilot.cjs");
    const runId = `incomplete-test-${Date.now()}`;
    cleanupPaths.push(getRunLogPath(runId));
    await writeFile(
      script,
      "console.log(JSON.stringify({ type: 'subagent.started', agentId: 'agent-1', data: { agentDisplayName: 'Analyst' } }));\n",
      "utf8"
    );

    const result = await startCopilotRun({
      runId,
      repoPath: directory,
      prompt: "test prompt",
      sessionId: "test-session-id",
      outputFormat: "json",
      executable: process.execPath,
      executableArgs: [script],
      trackProcessStats: false,
      timeoutSeconds: 30,
      maxIncompleteContinuations: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(result.incomplete).toBe(true);
    expect(result.continuationCount).toBe(1);
    expect(result.incompleteReason).toContain("1 unfinished background sub-agent");
  });

  it("shares one timeout deadline across automatic continuations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "work-board-deadline-"));
    cleanupPaths.push(directory);
    const script = path.join(directory, "fake-copilot.cjs");
    const runId = `deadline-test-${Date.now()}`;
    cleanupPaths.push(getRunLogPath(runId));
    await writeFile(
      script,
      [
        "const resumed = process.argv.slice(2).some((arg) => arg.startsWith('--resume='));",
        "console.log(JSON.stringify({ type: 'subagent.started', agentId: 'agent-1', data: { agentDisplayName: 'Analyst' } }));",
        "setTimeout(() => {}, resumed ? 3000 : 300);",
      ].join("\n"),
      "utf8"
    );

    const startedAt = Date.now();
    const result = await startCopilotRun({
      runId,
      repoPath: directory,
      prompt: "test prompt",
      sessionId: "test-session-id",
      outputFormat: "json",
      executable: process.execPath,
      executableArgs: [script],
      trackProcessStats: false,
      timeoutSeconds: 1.5,
      maxIncompleteContinuations: 3,
    });

    expect(result.timedOut).toBe(true);
    expect(result.continuationCount).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1750);
  });
});

describe("JobQueue", () => {
  it("serializes the same key while allowing different keys to use available slots", async () => {
    const queue = new JobQueue(2);
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    queue.enqueue("shared", async () => {
      started.push("shared-1");
      await first.promise;
    });
    queue.enqueue("shared", async () => {
      started.push("shared-2");
    });
    queue.enqueue("other", async () => {
      started.push("other");
      await second.promise;
    });
    await Promise.resolve();

    expect(started).toEqual(["shared-1", "other"]);
    first.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(["shared-1", "other", "shared-2"]);
    second.resolve();
  });
});