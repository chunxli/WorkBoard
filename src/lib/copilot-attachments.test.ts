import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "", send: vi.fn(), create: vi.fn(), resume: vi.fn(), insights: vi.fn(),
  listener: null as null | ((event: { type: string; data: { content?: string } }) => void),
}));
vi.mock("node:child_process", () => ({ execFileSync: () => "C:\\synthetic\\copilot.exe" }));
vi.mock("@github/copilot-sdk", () => ({
  approveAll: vi.fn(),
  RuntimeConnection: { forStdio: (options: object) => ({ ...options, kind: "stdio" }) },
  CopilotClient: class {
    start = async () => {};
    stop = async () => {};
    createSession = mocks.create;
    resumeSession = mocks.resume;
  },
}));
vi.mock("@/lib/copilot-runner", async (original) => ({
  ...await original<typeof import("@/lib/copilot-runner")>(),
  buildCopilotEnvironment: () => ({}),
  getRunLogPath: (id: string) => path.join(mocks.root, `${id}.log`),
}));
vi.mock("@/lib/copilot-session-insights", () => ({ readCopilotSessionInsights: mocks.insights }));
import { startCopilotCliControlledRun, startCopilotSdkRun } from "./copilot-sdk-runner";

describe("managed file attachment transport without real Copilot execution", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.root = await mkdtemp(path.join(tmpdir(), "workboard-attachment-runtime-"));
    const session = {
      send: mocks.send, abort: async () => {}, disconnect: async () => {},
      on: (listener: typeof mocks.listener) => { mocks.listener = listener; return () => { mocks.listener = null; }; },
    };
    mocks.create.mockResolvedValue(session); mocks.resume.mockResolvedValue(session);
    mocks.send.mockImplementation(async () => {
      queueMicrotask(() => {
        mocks.listener?.({ type: "assistant.message", data: { content: "Synthetic complete response" } });
        mocks.listener?.({ type: "session.idle", data: {} });
      });
      return { messageId: "synthetic-ack" };
    });
    mocks.insights.mockResolvedValue({
      eventCount: 2, completion: { taskComplete: true, rootFinalOutput: "Synthetic complete response",
        openSubagents: [], openTools: [], cancelledSubagents: [], failedSubagents: [], aborted: false },
    });
  });
  afterEach(async () => { await rm(mocks.root, { recursive: true, force: true }); });
  function options() {
    return { runId: randomUUID(), sessionId: randomUUID(), workPath: mocks.root, prompt: "",
      stdoutLogPath: path.join(mocks.root, "stdout.log"), stderrLogPath: path.join(mocks.root, "stderr.log"), timeoutSeconds: 5,
      attachments: [{ type: "file" as const, path: path.join(mocks.root, "synthetic.png"), displayName: "synthetic.png" }],
    };
  }
  it.each(["sdk-new", "sdk-resume", "cli-new", "cli-resume"])("passes real file options for %s", async (kind) => {
    const input = { ...options(), resumeSession: kind.endsWith("resume") };
    const result = await (kind.startsWith("cli") ? startCopilotCliControlledRun(input) : startCopilotSdkRun(input));
    expect(result.exitCode).toBe(0);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ prompt: "Please review the attached files.", attachments: input.attachments });
    expect(kind.endsWith("resume") ? mocks.resume : mocks.create).toHaveBeenCalledOnce();
  });
  it("retains attachments on a model fallback but not on automatic continuation", async () => {
    const input = { ...options(), model: "unavailable", fallbackModel: "synthetic-fallback" };
    mocks.send.mockRejectedValueOnce(new Error('Error: Model "unavailable" from --model flag is not available.'));
    mocks.insights
      .mockResolvedValueOnce({ eventCount: 0 })
      .mockResolvedValueOnce({ eventCount: 1, completion: { taskComplete: false, rootFinalOutput: null,
        openSubagents: [], openTools: ["unfinished"], cancelledSubagents: [], failedSubagents: [], aborted: false } });
    expect((await startCopilotCliControlledRun(input)).exitCode).toBe(0);
    expect(mocks.send).toHaveBeenCalledTimes(3);
    expect(mocks.send.mock.calls[0][0].attachments).toEqual(input.attachments);
    expect(mocks.send.mock.calls[1][0].attachments).toEqual(input.attachments);
    expect(mocks.send.mock.calls[2][0]).not.toHaveProperty("attachments");
  });
});
