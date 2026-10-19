import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state: { handler: ((event: unknown) => void) | null } = { handler: null };
  const send = vi.fn(async (_options: unknown) => "transport-ack");
  const abort = vi.fn(async () => {});
  const disconnect = vi.fn(async () => {});
  const on = vi.fn((handler: (event: unknown) => void) => {
    state.handler = handler;
    return () => { state.handler = null; };
  });
  const session = { send, abort, disconnect, on };
  const client = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async (): Promise<Error[]> => []),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
  };
  const completeInsights = {
    eventCount: 1,
    usage: null,
    completion: {
      openSubagents: [] as string[],
      cancelledSubagents: [] as string[],
      failedSubagents: [] as string[],
      openTools: [] as string[],
      rootFinalOutput: "Completed response" as string | null,
      taskComplete: true,
      sessionIdle: true,
      aborted: false,
    },
  };
  const insights = vi.fn(async () => completeInsights);
  return { state, send, abort, disconnect, on, session, client, insights, completeInsights };
});

vi.mock("@github/copilot-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@github/copilot-sdk")>();
  return {
    ...original,
    CopilotClient: vi.fn(class MockCopilotClient {
      constructor(..._args: unknown[]) {
        return harness.client as unknown as MockCopilotClient;
      }
    }),
  };
});
vi.mock("@/lib/copilot-session-insights", () => ({
  readCopilotSessionInsights: harness.insights,
}));

import { CopilotClient } from "@github/copilot-sdk";
import {
  cancelSdkRun,
  getCopilotCliPermissionArgs,
  startCopilotCliControlledRun,
  startCopilotSdkRun,
} from "./copilot-sdk-runner";
import { getManagedSessionController } from "./managed-session-controller";
import { getRunEmitter, getRunLogPath, type CopilotRunEvent } from "./copilot-runner";

const generatedPaths: string[] = [];

function options(runId: string) {
  const base = path.join(process.cwd(), "data", "steering-runner-tests", runId);
  generatedPaths.push(base, getRunLogPath(runId));
  return {
    runId,
    sessionId: `session-${runId}`,
    workPath: process.cwd(),
    prompt: "Original task",
    model: "gpt-test",
    contextTier: "default",
    reasoningEffort: "low",
    timeoutSeconds: null,
    stdoutLogPath: path.join(base, "stdout.log"),
    stderrLogPath: path.join(base, "stderr.log"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.state.handler = null;
  harness.send.mockReset().mockResolvedValue("transport-ack");
  harness.disconnect.mockReset().mockResolvedValue(undefined);
  harness.client.stop.mockReset().mockResolvedValue([]);
  harness.insights.mockReset().mockResolvedValue(harness.completeInsights);
});

afterEach(async () => {
  await Promise.all(generatedPaths.splice(0).map((filePath) => rm(filePath, { recursive: true, force: true })));
});

describe("controlled Copilot runner lifecycle", () => {
  function completeEachSend() {
    harness.send.mockImplementation(async () => {
      harness.state.handler?.({ type: "session.idle", data: {} });
      return "transport-ack";
    });
  }

  it.each(["send", "session.error"] as const)(
    "retries an unavailable CLI model once on the same session after %s with the configured fallback",
    async (failure) => {
    completeEachSend();
    const modelError = 'Error: Model "gpt-test" from --model flag is not available.';
    if (failure === "send") harness.send.mockRejectedValueOnce(new Error(modelError));
    else harness.send.mockImplementationOnce(async () => {
      harness.state.handler?.({ type: "session.error", data: { message: modelError } });
      return "initial-ack";
    });
    const config = options(`fallback-${randomUUID()}`);
    const result = await startCopilotCliControlledRun({ ...config, fallbackModel: "fallback-test" });

    expect(result).toMatchObject({ exitCode: 0, model: "fallback-test", continuationCount: 0 });
    expect(harness.client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: config.sessionId, model: "gpt-test",
    }));
    expect(harness.client.resumeSession).toHaveBeenCalledWith(config.sessionId, expect.objectContaining({
      model: "fallback-test", continuePendingWork: false, enableConfigDiscovery: true,
    }));
    expect(harness.send.mock.calls.map(([message]) => message)).toEqual([
      { prompt: config.prompt }, { prompt: config.prompt },
    ]);
    expect(harness.disconnect).toHaveBeenCalledTimes(2);
    expect(harness.client.stop).toHaveBeenCalledOnce();
    }
  );

  it("does not repeatedly fallback when the fallback model is also unavailable", async () => {
    harness.send.mockRejectedValue(new Error('Error: Model "missing" from --model flag is not available.'));
    await expect(startCopilotCliControlledRun({
      ...options(`fallback-failed-${randomUUID()}`), fallbackModel: "fallback-test",
    })).rejects.toThrow("not available");
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.client.resumeSession).toHaveBeenCalledOnce();
    expect(harness.client.stop).toHaveBeenCalledOnce();
  });

  it("continues incomplete CLI work in the same session until completion is confirmed", async () => {
    completeEachSend();
    harness.insights
      .mockResolvedValueOnce(harness.completeInsights)
      .mockResolvedValueOnce({
        ...harness.completeInsights,
        eventCount: 7,
        completion: { ...harness.completeInsights.completion, openTools: ["tool-1"], taskComplete: false, rootFinalOutput: null },
      });
    const config = options(`continue-${randomUUID()}`);
    const result = await startCopilotCliControlledRun(config);

    expect(result).toMatchObject({ exitCode: 0, incomplete: false, continuationCount: 1 });
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.send).toHaveBeenLastCalledWith({
      prompt: expect.stringContaining("Continue and complete the original task."),
    });
    expect(harness.insights).toHaveBeenLastCalledWith(config.sessionId, 7);
    expect(harness.client.createSession).toHaveBeenCalledOnce();
    expect(harness.client.resumeSession).not.toHaveBeenCalled();
  });

  it("exhausts exactly three CLI incomplete continuations and never reports success", async () => {
    completeEachSend();
    harness.insights.mockResolvedValue({
      ...harness.completeInsights,
      completion: {
        ...harness.completeInsights.completion,
        rootFinalOutput: null,
        taskComplete: false,
        openSubagents: ["unfinished-agent"],
      },
    });
    const result = await startCopilotCliControlledRun(options(`exhausted-${randomUUID()}`));
    expect(result).toMatchObject({
      exitCode: null,
      incomplete: true,
      continuationCount: 3,
      incompleteReason: expect.stringContaining("unfinished background sub-agent(s) after 3"),
    });
    expect(harness.send).toHaveBeenCalledTimes(4);
    expect(harness.client.createSession).toHaveBeenCalledOnce();
    expect(harness.client.resumeSession).not.toHaveBeenCalled();
    expect(harness.client.stop).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "stop-result", "stop-rejection"] as const)(
    "rejects a completed Run when %s shutdown fails while still cleaning up",
    async (failure) => {
      completeEachSend();
      if (failure === "disconnect") harness.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
      if (failure === "stop-result") harness.client.stop.mockResolvedValueOnce([new Error("process alive")]);
      if (failure === "stop-rejection") harness.client.stop.mockRejectedValueOnce(new Error("stop failed"));
      const config = options(`shutdown-${randomUUID()}`);
      const events: CopilotRunEvent[] = [];
      harness.send.mockImplementation(async () => {
        getRunEmitter(config.runId)?.on("event", (event: CopilotRunEvent) => events.push(event));
        harness.state.handler?.({ type: "session.idle", data: {} });
        return "transport-ack";
      });
      await expect(startCopilotCliControlledRun(config)).rejects.toThrow("shutdown could not be confirmed");
      expect(harness.client.stop).toHaveBeenCalledOnce();
      expect(getManagedSessionController(config.runId)).toBeNull();
      expect(cancelSdkRun(config.runId)).toBe(false);
      expect(events.some((event) => event.type === "exit")).toBe(false);
      expect(events).toContainEqual({
        type: "error", message: "Copilot runtime shutdown could not be confirmed.",
      });
      expect(getRunEmitter(config.runId)).toBeUndefined();
    }
  );

  it("does not publish success or resolve until runtime shutdown finishes", async () => {
    const config = options(`shutdown-wait-${randomUUID()}`);
    const events: CopilotRunEvent[] = [];
    let finishStop!: (errors: Error[]) => void;
    harness.client.stop.mockImplementationOnce(() => new Promise<Error[]>((resolve) => { finishStop = resolve; }));
    harness.send.mockImplementation(async () => {
      getRunEmitter(config.runId)?.on("event", (event: CopilotRunEvent) => events.push(event));
      harness.state.handler?.({ type: "session.idle", data: {} });
      return "transport-ack";
    });
    let resolved = false;
    const run = startCopilotCliControlledRun(config).then((result) => { resolved = true; return result; });
    await vi.waitFor(() => expect(harness.client.stop).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    expect(events.some((event) => event.type === "exit")).toBe(false);
    finishStop([]);
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
    expect(events).toContainEqual({ type: "exit", code: 0, timedOut: false, cancelled: false });
  });

  it.each(["accepted", "rejected"] as const)(
    "fails and tears down after session.error during a pending Steering send that is later %s",
    async (outcome) => {
      let accept!: (ack: string) => void;
      let reject!: (error: Error) => void;
      harness.send.mockImplementation(async (message) => {
        if (typeof message === "object" && message !== null && "mode" in message) {
          return new Promise<string>((resolve, fail) => { accept = resolve; reject = fail; });
        }
        return "initial-ack";
      });
      const config = options(`error-pending-${randomUUID()}`);
      const run = startCopilotCliControlledRun(config);
      const runFailure = expect(run).rejects.toThrow("session failed during Steering");
      await vi.waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
      const reservation = getManagedSessionController(config.runId)!.reserveSteering()!;
      const sending = reservation.send("redirect");
      harness.state.handler?.({ type: "session.error", data: { message: "session failed during Steering" } });
      harness.state.handler?.({ type: "session.idle", data: {} });
      if (outcome === "accepted") {
        accept("steering-ack");
        await expect(sending).resolves.toMatchObject({ accepted: true });
      } else {
        const sendFailure = expect(sending).rejects.toThrow("send failed");
        reject(new Error("send failed"));
        await sendFailure;
      }
      await runFailure;
      expect(harness.disconnect).toHaveBeenCalledOnce();
      expect(harness.client.stop).toHaveBeenCalledOnce();
      expect(getManagedSessionController(config.runId)).toBeNull();
    }
  );

  it("steers an active CLI turn, serializes idle, and waits for final teardown", async () => {
    let acceptSteering!: (value: string) => void;
    harness.send.mockImplementation(async (message) => {
      if (typeof message === "object" && message !== null && "mode" in message) {
        return new Promise<string>((resolve) => { acceptSteering = resolve; });
      }
      return "initial-ack";
    });
    const runId = `cli-${randomUUID()}`;
    const run = startCopilotCliControlledRun({
      ...options(runId),
      agent: "reviewer",
      permissionMode: "default",
      outputFormat: "text",
    });
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith({ prompt: "Original task" }));
    const controller = getManagedSessionController(runId);
    expect(controller?.canAcceptSteering).toBe(true);
    const reservation = controller?.reserveSteering();
    expect(reservation).not.toBeNull();
    const steering = reservation!.send("Keep the API stable");
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith({
      prompt: "Keep the API stable",
      mode: "immediate",
    }));

    harness.state.handler?.({ type: "session.idle", data: {} });
    let completed = false;
    void run.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    acceptSteering("steering-ack");
    await expect(steering).resolves.toMatchObject({
      accepted: true,
      messageId: "steering-ack",
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    harness.state.handler?.({ type: "session.idle", data: {} });

    const result = await run;
    expect(result).toMatchObject({
      exitCode: 0,
      command: expect.stringContaining("--headless --stdio --no-auto-update --allow-all-tools"),
      pid: null,
      cpuTimeMs: null,
      peakMemoryMb: null,
      finalOutput: "Completed response",
    });
    expect(CopilotClient).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ kind: "stdio", args: getCopilotCliPermissionArgs("default") }),
    }));
    expect(CopilotClient).toHaveBeenCalledOnce();
    expect(harness.client.start).toHaveBeenCalledOnce();
    expect(harness.client.createSession).toHaveBeenCalledOnce();
    expect(harness.client.resumeSession).not.toHaveBeenCalled();
    expect(harness.client.stop).toHaveBeenCalledOnce();
    expect(getManagedSessionController(runId)).toBeNull();
  });

  it("cancels an SDK-controlled session through the same lifecycle and tears it down", async () => {
    const runId = `sdk-${randomUUID()}`;
    const run = startCopilotSdkRun(options(runId));
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledWith({ prompt: "Original task" }));

    expect(cancelSdkRun(runId)).toBe(true);
    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.client.stop).toHaveBeenCalledOnce();
  });
});
