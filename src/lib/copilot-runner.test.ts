import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insights: vi.fn() }));
vi.mock("@/lib/copilot-session-insights", async (original) => ({
  ...await original<typeof import("./copilot-session-insights")>(),
  readCopilotSessionInsights: mocks.insights,
}));
import { cancelRun, getRunLogPath, isNativeCopilotRunActive, startCopilotRun } from "./copilot-runner";
import * as processControl from "./copilot-process";

let root: string;
let script: string;
let runIds: string[];
let siblings: ChildProcess[];
beforeEach(async () => {
  mocks.insights.mockResolvedValue(null);
  runIds = [];
  siblings = [];
  root = await mkdtemp(path.join(tmpdir(), "workboard-native-runner-"));
  script = path.join(root, "fake-cli.mjs");
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [scenario, record, ...args] = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const save = extra => appendFileSync(record, JSON.stringify({ args, cwd: process.cwd(), sdkEntra: process.env.WORKBOARD_COPILOT_ENTRA_CLIENT_ID ?? null, ...extra }) + '\\n');
if (scenario === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  save({ childPid: child.pid });
  setInterval(() => {}, 1000);
} else {
  save({});
  if (scenario === 'stdin') {
    process.stdin.resume();
    process.stdin.on('end', () => emit({ type: 'assistant.message', data: { content: 'Synthetic stdin closed' } }));
  } else if (scenario === 'fallback' && args[args.indexOf('--model') + 1] === 'unavailable') {
    process.stderr.write('Error: Model "unavailable" from --model flag is not available.\\n');
    process.exitCode = 1;
  } else if (scenario === 'continue' && !args.some(arg => arg.startsWith('--resume='))) {
    emit({ type: 'tool.execution_start', data: { toolCallId: 'unfinished', toolName: 'synthetic' } });
  } else if (scenario === 'unicode') {
    const bytes = Buffer.from(JSON.stringify({ type: 'assistant.message', data: { content: 'Synthetic \\u4e2d\\u6587' } }) + '\\n');
    const split = bytes.indexOf(Buffer.from('\\u4e2d')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
  } else {
    if (scenario === 'auth-error') {
      emit({ type: 'tool.execution_start', data: { toolCallId: 'auth', toolName: 'protected-search' } });
      emit({ type: 'tool.execution_complete', data: { toolCallId: 'auth', success: false, error: { message: 'MCP requires authentication' } } });
    }
    emit({ type: 'assistant.message', data: { content: scenario === 'long' ? 'x'.repeat(20000) : 'Synthetic final response' } });
  }
}
`);
});
afterEach(async () => {
  for (const id of runIds) {
    await cancelRun(id);
    await rm(getRunLogPath(id), { force: true });
  }
  for (const child of siblings) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function options(scenario = "success") {
  const runId = randomUUID();
  runIds.push(runId);
  return {
    runId, repoPath: root, sessionId: randomUUID(), prompt: "Synthetic task",
    outputFormat: "json" as const, timeoutSeconds: 10, trackProcessStats: false,
    executable: process.execPath, executableArgs: [script, scenario, path.join(root, `${runId}.jsonl`)],
  };
}
async function records(runId: string): Promise<{ args: string[]; cwd: string; sdkEntra: string | null; childPid?: number }[]> {
  return (await readFile(path.join(root, `${runId}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("native CLI process execution without SDK", () => {
  it("uses native prompt/session/attachment flags and ignores SDK-only Entra configuration", async () => {
    vi.stubEnv("WORKBOARD_COPILOT_ENTRA_CLIENT_ID", "invalid-sdk-host-config");
    const input = options();
    const attachment = path.join(root, "evidence \u56fe.png");
    const result = await startCopilotRun({ ...input, prompt: "", attachmentPaths: [attachment] });
    expect(result).toMatchObject({ exitCode: 0, incomplete: false, cancelled: false });
    const [record] = await records(input.runId);
    expect(record.args).toEqual(expect.arrayContaining(["-p", "Please review the attached files.", "--session-id", input.sessionId, "--attachment", attachment, "--stream", "on", "--allow-all-tools"]));
    expect(record.args).not.toContain("--headless");
    expect(record.args).not.toContain("--stdio");
    expect(record.args).not.toContain("--allow-all");
    expect(record.args).toContain("GH_TOKEN,GITHUB_TOKEN,COPILOT_GITHUB_TOKEN");
    expect(record.sdkEntra).toBeNull();
    expect(record.cwd).toBe(root);
    expect(result.command).not.toContain("Please review the attached files.");
  });

  it("resumes the same native session with only the new follow-up prompt", async () => {
    const input = options();
    expect((await startCopilotRun({ ...input, resumeSession: true, prompt: "New follow-up", permissionMode: "full" })).exitCode).toBe(0);
    const [record] = await records(input.runId);
    expect(record.args).toContain(`--resume=${input.sessionId}`);
    expect(record.args).not.toContain("--session-id");
    expect(record.args).toContain("New follow-up");
    expect(record.args).toContain("--allow-all");
  });

  it("closes unused stdin rather than leaving a non-interactive process waiting for input", async () => {
    expect(await startCopilotRun(options("stdin"))).toMatchObject({ exitCode: 0, timedOut: false, incomplete: false });
  });

  it("retains attachments on model fallback but not on automatic continuation", async () => {
    const fallback = options("fallback");
    const attachment = path.join(root, "input.txt");
    expect((await startCopilotRun({ ...fallback, attachmentPaths: [attachment], model: "unavailable", fallbackModel: "available" })).exitCode).toBe(0);
    const attempts = await records(fallback.runId);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((record) => record.args.includes(attachment))).toBe(true);
    const continuation = options("continue");
    expect(await startCopilotRun({ ...continuation, attachmentPaths: [attachment], maxIncompleteContinuations: 1 }))
      .toMatchObject({ exitCode: 0, incomplete: false, continuationCount: 1 });
    const continued = await records(continuation.runId);
    expect(continued).toHaveLength(2);
    expect(continued[1].args).toContain(`--resume=${continuation.sessionId}`);
    expect(continued[1].args).not.toContain("--attachment");
    expect(continued[1].args).not.toContain(continuation.prompt);
  });

  it("preserves UTF-8 output split across process chunks", async () => {
    const input = options("unicode");
    const result = await startCopilotRun(input);
    expect(result.exitCode).toBe(0);
    expect(await readFile(result.logPath, "utf8")).toContain("Synthetic \u4e2d\u6587");
    expect(await readFile(result.logPath, "utf8")).not.toContain("\uFFFD");
  });

  it("retains native MCP errors even when the CLI process exits successfully", async () => {
    const input = options("auth-error");
    const result = await startCopilotRun(input);
    expect(result.exitCode).toBe(0);
    const log = await readFile(result.logPath, "utf8");
    expect(log).toContain('"success":false');
    expect(log).toContain("MCP requires authentication");
  });

  it("preserves a full current-turn text result beyond the rolling diagnostic tail", async () => {
    const text = "x".repeat(20000);
    mocks.insights.mockResolvedValue({
      eventCount: 1, completion: {
        taskComplete: true, rootFinalOutput: text, openSubagents: [], openTools: [],
        cancelledSubagents: [], failedSubagents: [], aborted: false,
      },
    });
    const result = await startCopilotRun({ ...options("long"), outputFormat: "text" });
    expect(result).toMatchObject({ exitCode: 0, incomplete: false, finalOutput: text });
  });

  it.each(["cancel", "timeout"] as const)("terminates only the owned CLI process tree on %s", async (kind) => {
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    siblings.push(sibling);
    const input = options("hang");
    const execution = startCopilotRun({ ...input, timeoutSeconds: kind === "timeout" ? 1 : 15 });
    let childPid: number | undefined;
    await vi.waitFor(async () => {
      childPid = (await records(input.runId))[0].childPid;
      expect(childPid).toBeTypeOf("number");
    });
    expect(isNativeCopilotRunActive(input.runId)).toBe(true);
    if (kind === "cancel") {
      const stop = vi.spyOn(processControl, "stopCopilotProcess");
      expect(await Promise.all([cancelRun(input.runId), cancelRun(input.runId)])).toEqual([true, true]);
      expect(stop).toHaveBeenCalledOnce();
    }
    expect(await execution).toMatchObject({ timedOut: kind === "timeout", cancelled: kind === "cancel" });
    expect(isNativeCopilotRunActive(input.runId)).toBe(false);
    await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow());
    expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
  }, 20000);
});
