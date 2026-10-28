import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "", send: vi.fn(), create: vi.fn(), resume: vi.fn(), insights: vi.fn(), skillDirectories: vi.fn(),
  listener: null as null | ((event: { type: string; data: { content?: string } }) => void),
}));
vi.mock("node:child_process", () => ({ execFileSync: () => "C:\\synthetic\\copilot.exe" }));
vi.mock("@github/copilot-sdk", async (original) => ({
  ...await original<typeof import("@github/copilot-sdk")>(),
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
vi.mock("@/lib/copilot-skill-directories", () => ({ readCopilotSkillDirectories: mocks.skillDirectories }));
import { startCopilotCliControlledRun, startCopilotSdkRun } from "./copilot-sdk-runner";

describe("managed file attachment transport without real Copilot execution", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.skillDirectories.mockResolvedValue(["C:\\synthetic\\user-skills"]);
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
    const config = kind.endsWith("resume") ? mocks.resume.mock.calls[0][1] : mocks.create.mock.calls[0][0];
    expect(config.skillDirectories).toEqual(["C:\\synthetic\\user-skills"]);
  });
  it.each([false, true])("handles full-access CLI approvals during execution (resume=%s)", async (resumeSession) => {
    const send = mocks.send.getMockImplementation();
    if (!send) throw new Error("Missing synthetic send implementation");
    mocks.send.mockImplementationOnce(async (...args) => {
      const config = resumeSession ? mocks.resume.mock.calls[0][1] : mocks.create.mock.calls[0][0];
      expect(config.onPermissionRequest).toBeTypeOf("function");
      for (const request of [
        { kind: "read" as const, path: "C:\\synthetic\\outside-work\\evidence.txt", intention: "Read synthetic evidence" },
        { kind: "url" as const, url: "https://example.com/", intention: "Fetch public example" },
      ]) {
        expect(await config.onPermissionRequest(request, { sessionId: "synthetic-session" })).toEqual({ kind: "approve-once" });
      }
      return send(...args);
    });
    const result = await startCopilotCliControlledRun({ ...options(), permissionMode: "full", resumeSession });
    expect(result.exitCode).toBe(0);
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it("retains attachments on a model fallback but not on automatic continuation", async () => {
    const input = { ...options(), permissionMode: "full" as const, model: "unavailable", fallbackModel: "synthetic-fallback" };
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
    expect(mocks.resume.mock.calls[0][1].skillDirectories).toEqual(["C:\\synthetic\\user-skills"]);
    const original = mocks.create.mock.calls[0][0];
    const resumed = mocks.resume.mock.calls[0][1];
    expect(resumed.onPermissionRequest).toBe(original.onPermissionRequest);
    expect(resumed.onUserInputRequest).toBe(original.onUserInputRequest);
    expect(resumed.onElicitationRequest).toBe(original.onElicitationRequest);
    expect(await resumed.onPermissionRequest({ kind: "read", path: "C:\\synthetic", intention: "Read synthetic" }, { sessionId: input.sessionId }))
      .toEqual({ kind: "approve-once" });
  });
});
