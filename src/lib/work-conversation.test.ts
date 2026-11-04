import { hostname } from "node:os";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  user: vi.fn(), work: { findFirst: vi.fn() }, run: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  steering: { findMany: vi.fn(), updateMany: vi.fn() },
  conflicts: vi.fn(), activity: vi.fn(), reconcile: vi.fn(), exists: vi.fn(), repair: vi.fn(),
  history: vi.fn(), create: vi.fn(), append: vi.fn(), execute: vi.fn(), enqueue: vi.fn(),
  nativeActive: vi.fn(),
  pins: { findFirst: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { work: services.work, run: services.run, workSteeringMessage: services.steering, workConversationPin: services.pins },
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: services.user }));
vi.mock("@/lib/auth-mode", () => ({ authMode: "local" }));
vi.mock("@/lib/run-access", () => ({ findActiveRunConflicts: services.conflicts }));
vi.mock("@/lib/terminal-resume", () => ({ getTerminalSessionActivity: services.activity, reconcileTerminalRun: services.reconcile }));
vi.mock("@/lib/copilot-session-compat", async (original) => ({
  ...await original<typeof import("./copilot-session-compat")>(),
  copilotSessionExists: services.exists, repairLegacyCopilotSessionEvents: services.repair,
}));
vi.mock("@/lib/session-conversation", async (original) => ({
  ...await original<typeof import("./session-conversation")>(), readSessionConversationPage: services.history,
}));
vi.mock("@/lib/work-executor", () => ({
  createPendingFollowUpRun: services.create, ensureFollowUpPrompt: services.append,
  executeWorkRun: services.execute, getWorkRunQueueKey: () => "session:test",
}));
vi.mock("@/lib/job-queue", () => ({ jobQueue: { enqueue: services.enqueue } }));
vi.mock("@/lib/copilot-runner", () => ({ isNativeCopilotRunActive: services.nativeActive }));

import { GET } from "../app/api/works/[id]/conversation/route";
import { POST } from "../app/api/works/[id]/follow-up/route";
import { CopilotSessionInUseError } from "./copilot-session-compat";
import { ConversationReadError, normalizeConversationEvent } from "./session-conversation";
import { pinContentHash } from "./conversation-pins";
import { ManagedSessionController, registerManagedSessionController, unregisterManagedSessionController } from "./managed-session-controller";

const sessionId = "12345678-1234-4234-8234-123456789abc";
let parent: {
  id: string; workId: string; status: string; trigger: string; hostname: string | null;
  copilotSessionId: string; executionPath: string; createdAt: Date; startedAt: Date | null;
  finishedAt: Date | null; terminalLaunches: { id: string }[];
  engine: "CLI" | "SDK";
  concurrencyMode: string | null; resumedFromRunId: string | null; promptSnapshot: string | null; attachmentsJson: string | null;
};
let sessionRuns: typeof parent[];
const context = { params: Promise.resolve({ id: "work-1" }) };
const request = (query = "") => new NextRequest(`http://localhost/api/works/work-1/conversation${query}`);
const followUp = (body: unknown) => POST(new NextRequest("http://localhost/api/works/work-1/follow-up", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), context);

beforeEach(() => {
  vi.resetAllMocks();
  parent = { id: "run-1", workId: "work-1", status: "SUCCESS", trigger: "WORK", hostname: hostname(),
    copilotSessionId: sessionId, executionPath: "C:/example", createdAt: new Date(), startedAt: new Date(), finishedAt: new Date(), terminalLaunches: [], engine: "CLI",
    concurrencyMode: "DIRECT", resumedFromRunId: null, promptSnapshot: null, attachmentsJson: null };
  sessionRuns = [parent];
  services.nativeActive.mockReturnValue(false);
  services.user.mockResolvedValue("owner");
  services.work.findFirst.mockResolvedValue({ id: "work-1", hostname: hostname(), status: "ACTIVE", directoryPath: "C:/example", promptFileName: "PROMPT.md", promptHash: "hash" });
  services.run.findFirst.mockImplementation(async ({ where }) => {
    if (where.copilotSessionId && where.OR) return null;
    if (where.status?.in) return sessionRuns.find((run) => where.status.in.includes(run.status)) ?? null;
    if (where.id && typeof where.id === "string") return sessionRuns.find((run) => run.id === where.id) ?? null;
    if (where.status?.notIn) return sessionRuns.find((run) => !where.status.notIn.includes(run.status) && run.startedAt !== null) ?? null;
    return parent;
  });
  services.run.findMany.mockImplementation(async ({ where }) => sessionRuns.filter((run) =>
    (!where.workId || run.workId === where.workId) &&
    (!where.copilotSessionId || run.copilotSessionId === where.copilotSessionId) &&
    (!where.status?.in || where.status.in.includes(run.status)) &&
    (!where.id?.in || where.id.in.includes(run.id)) &&
    (!where.id?.not || where.id.not !== run.id)));
  services.run.findUnique.mockImplementation(async ({ where }) => sessionRuns.find((run) => run.id === where.id) ?? null);
  services.steering.findMany.mockResolvedValue([]);
  services.steering.updateMany.mockResolvedValue({ count: 0 });
  services.pins.findFirst.mockResolvedValue(null);
  services.conflicts.mockResolvedValue([]);
  services.activity.mockResolvedValue({ active: false, starting: false, wrapperExited: true, exitCode: null });
  services.exists.mockResolvedValue(true);
  services.repair.mockResolvedValue({ repairedEvents: 0, eventCount: 1, backupPath: null });
  services.history.mockResolvedValue({ events: [], nextCursor: "next", previousCursor: null,
    hasMore: false, hasEarlier: false, incompleteTail: false, revision: "revision", generation: "source", sourceBytes: 100 });
  services.create.mockResolvedValue({ id: "follow-up-run", copilotSessionId: sessionId, promptSnapshot: "Continue", createdAt: new Date() });
});

describe("owned session conversation API", () => {
  it("loads and verifies a Pin in the same owned session while retaining normal conversation metadata", async () => {
    const event = normalizeConversationEvent({ type: "assistant.message", data: { content: "Older output\n\n```text\nPinned code\n```" } }, "a".repeat(64), 1200)!;
    const pin = { id: "pin", workId: "work-1", sessionId, eventId: event.id, eventOffset: event.offset, line: 4, contentHash: pinContentHash(event) };
    services.pins.findFirst.mockResolvedValue(pin);
    services.history.mockResolvedValue({ events: [event], nextCursor: "after-pin", previousCursor: "before-pin",
      hasEarlier: true, hasMore: true, incompleteTail: false });
    const response = await GET(request("?runId=run-1&pin=pin"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId, anchorRunId: "run-1", events: [event], nextCursor: "after-pin", canFollowUp: true });
    expect(services.pins.findFirst).toHaveBeenCalledWith({ where: { id: "pin", workId: "work-1", sessionId } });
    expect(services.history).toHaveBeenCalledWith(sessionId, { atOffset: 1200 });
  });

  it("does not fall back to normal history for foreign/missing Pins or ambiguous cursor requests", async () => {
    expect((await GET(request("?runId=run-1&pin=missing"), context)).status).toBe(404);
    expect(services.history).not.toHaveBeenCalled();
    expect((await GET(request("?runId=run-1&pin=pin&cursor=next"), context)).status).toBe(400);
    expect((await GET(request("?runId=run-1&pin=pin&before=previous"), context)).status).toBe(400);
    expect((await GET(request("?runId=run-1&pin=pin&download=1"), context)).status).toBe(400);
  });

  it("surfaces edited Pin content rather than returning a successful unrelated history page", async () => {
    const original = normalizeConversationEvent({ type: "assistant.message", data: { content: "Original" } }, "a".repeat(64), 0)!;
    services.pins.findFirst.mockResolvedValue({ eventId: original.id, line: 1, contentHash: pinContentHash(original), eventOffset: 0 });
    services.history.mockResolvedValue({ events: [{ ...original, text: "Modified" }] });
    const response = await GET(request("?runId=run-1&pin=pin"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("changed or replaced") });
  });
  it.each(["PENDING", "RUNNING"])("waits for missing history during %s and recovers when the file appears", async (status) => {
    parent.status = status;
    services.history.mockRejectedValueOnce(Object.assign(new Error("Not created yet"), { code: "ENOENT" }));
    const waiting = await GET(request(), context);
    expect(waiting.status).toBe(200);
    const body = await waiting.json();
    expect(body.historyAvailable).toBe(false);
    expect(body.historyUnavailableReason).toContain("Waiting for this Run to record");
    expect(body.historyUnavailableReason).not.toContain("unavailable");
    expect(body.blockedReason).not.toContain("Start a new Work Run");
    expect(body.canFollowUp).toBe(false);
    const ready = await (await GET(request(), context)).json();
    expect(ready.historyAvailable).toBe(true);
    expect(ready.historyUnavailableReason).toBeNull();
  });

  it("authorizes the Work before reading local history", async () => {
    services.work.findFirst.mockResolvedValue(null);
    expect((await GET(request(), context)).status).toBe(404);
    expect(services.history).not.toHaveBeenCalled();
    expect(services.work.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "work-1", userId: "owner" } }));
  });

  it("rejects unauthorized and arbitrary session/path requests", async () => {
    services.user.mockResolvedValue(null);
    expect((await GET(request(), context)).status).toBe(401);
    services.user.mockResolvedValue("owner");
    expect((await GET(request("?sessionId=arbitrary"), context)).status).toBe(400);
    expect((await GET(request("?path=C:/secret"), context)).status).toBe(400);
    expect((await GET(request("?runId=other-run"), context)).status).toBe(404);
    expect(services.history).not.toHaveBeenCalled();
  });

  it("does not read local files for another host or a shared foreign Work session", async () => {
    parent.hostname = "other-host";
    expect((await GET(request(), context)).status).toBe(409);
    parent.hostname = hostname();
    services.run.findFirst.mockImplementationOnce(async () => parent).mockImplementationOnce(async () => ({ id: "foreign-run" }));
    expect((await GET(request(), context)).status).toBe(409);
    expect(services.history).not.toHaveBeenCalled();
  });

  it("does not limit full session membership to the Work page's twenty Runs", async () => {
    sessionRuns = Array.from({ length: 25 }, (_, index) => ({ ...parent, id: `run-${index}` }));
    const response = await GET(request(), context);
    const body = await response.json();
    expect(body.runs).toHaveLength(25);
    expect(body.historyAvailable).toBe(true);
    expect(body.canFollowUp).toBe(true);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(services.history).toHaveBeenCalledWith(sessionId, { cursor: undefined, before: undefined });
    expect(services.repair).not.toHaveBeenCalled();
    expect(services.reconcile).not.toHaveBeenCalled();
  });

  it("reads active history but blocks sending while Terminal owns the session", async () => {
    services.activity.mockResolvedValue({ active: true, starting: false });
    const body = await (await GET(request(), context)).json();
    expect(body.historyAvailable).toBe(true);
    expect(body.canFollowUp).toBe(false);
    expect(body.blockedReason).toContain("Terminal");
  });

  it("allows queueing but not Steering for an App-owned native CLI session", async () => {
    parent.status = "RUNNING";
    services.nativeActive.mockReturnValue(true);
    services.activity.mockResolvedValue({ active: true, starting: false });
    services.conflicts.mockResolvedValue([{ id: parent.id }]);
    const body = await (await GET(request(), context)).json();
    expect(body).toMatchObject({ historyAvailable: true, terminalActive: false, canSteer: false, canFollowUp: false, canQueue: true, queueParentRunId: parent.id });
    expect(body.steeringBlockedReason).toContain("Native CLI Runs do not support Steering");
    expect(body.blockedReason).toContain("Wait");
    expect(services.activity).not.toHaveBeenCalled();
  });

  it("enables native Follow up again after its Run and owned process end", async () => {
    const body = await (await GET(request(), context)).json();
    expect(body).toMatchObject({ canFollowUp: true, canSteer: false, terminalActive: false, continuationParentRunId: parent.id });
  });

  it("keeps missing history and source resets explicit", async () => {
    services.history.mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOENT" }));
    const body = await (await GET(request(), context)).json();
    expect(body.historyAvailable).toBe(false);
    expect(body.canFollowUp).toBe(false);
    services.history.mockRejectedValueOnce(new ConversationReadError("Reload", 409, true));
    const response = await GET(request("?cursor=stale"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reset: true });
  });
});

describe("conversation follow-up submission", () => {
  it("settles a stopped Terminal parent before creating its linked Follow Up", async () => {
    parent.status = "RUNNING";
    parent.trigger = "TERMINAL_RESUME";
    services.reconcile.mockImplementationOnce(async () => { parent.status = "SUCCESS"; });
    const response = await followUp({ prompt: "Continue", expectedParentRunId: parent.id });
    expect(response.status).toBe(202);
    expect(services.reconcile).toHaveBeenCalledWith(parent.id, expect.any(Date), { settleStopped: true });
    expect(services.reconcile.mock.invocationCallOrder[0]).toBeLessThan(services.create.mock.invocationCallOrder[0]);
    expect(services.create).toHaveBeenCalledWith({
      workId: "work-1", prompt: "Continue", parentRunId: parent.id, requestId: undefined, attachments: [],
    });
  });

  it("does not force continuation when a Terminal parent cannot yet settle", async () => {
    parent.status = "RUNNING";
    parent.trigger = "TERMINAL_RESUME";
    services.run.findFirst.mockImplementation(async ({ where }) =>
      where.status?.in ? { id: parent.id } : parent,
    );
    const response = await followUp({ prompt: "Keep my draft", expectedParentRunId: parent.id });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("active Work Run") });
    expect(services.create).not.toHaveBeenCalled();
    expect(services.append).not.toHaveBeenCalled();
  });

  it("logs settlement failures and requires a same-request retry without creating or enqueueing another session", async () => {
    parent.status = "RUNNING";
    parent.trigger = "TERMINAL_RESUME";
    const failure = new Error("Session history changed; retry synchronization");
    services.reconcile.mockRejectedValueOnce(failure);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await followUp({ prompt: "Keep my draft", expectedParentRunId: parent.id });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Unable to confirm Follow Up. Retry this same request." });
      expect(logger).toHaveBeenCalledWith("[follow-up] Failed to create or enqueue Follow Up:", failure);
      expect(services.create).not.toHaveBeenCalled();
      expect(services.append).not.toHaveBeenCalled();
      expect(services.enqueue).not.toHaveBeenCalled();
    } finally {
      logger.mockRestore();
    }
  });

  it("appends accepted input to Prompt once per Run and queues the same session", async () => {
    const response = await followUp({ prompt: "Continue", expectedParentRunId: "run-1" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: "follow-up-run", sessionId, resumed: true });
    expect(services.create).toHaveBeenCalledWith({
      workId: "work-1", prompt: "Continue", parentRunId: "run-1", requestId: undefined, attachments: [],
    });
    expect(services.append).toHaveBeenCalledWith(expect.objectContaining({ id: "work-1" }), expect.objectContaining({ id: "follow-up-run" }));
    expect(services.enqueue).toHaveBeenCalledWith(`session:${sessionId}`, expect.any(Function));
  });

  describe("durable queued conversation messages", () => {
    const queuedRequest = (prompt: string, parentRunId: string, requestId: string) => ({
      prompt, expectedParentRunId: parentRunId, requestId, queue: true,
    });
    beforeEach(() => {
      parent.status = "RUNNING";
      parent.finishedAt = null;
      services.nativeActive.mockReturnValue(true);
      services.conflicts.mockImplementation(async () => sessionRuns.filter((run) => ["PENDING", "RUNNING"].includes(run.status)).map(({ id }) => ({ id })));
      services.create.mockImplementation(async (options) => {
        const row = { ...parent, id: options.requestId, trigger: "FOLLOW_UP", status: "PENDING", hostname: null, startedAt: null, finishedAt: null,
          concurrencyMode: "FOLLOW_UP_QUEUED", resumedFromRunId: options.parentRunId, promptSnapshot: options.prompt,
          createdAt: new Date(parent.createdAt.getTime() + sessionRuns.length), attachmentsJson: null };
        sessionRuns.unshift(row);
        return row;
      });
    });

    it("chains multiple messages in the same session without syncing Prompt or repairing active history", async () => {
      const firstId = "11111111-1111-4111-8111-111111111111";
      const secondId = "22222222-2222-4222-8222-222222222222";
      expect((await followUp(queuedRequest("First", parent.id, firstId))).status).toBe(202);
      const response = await followUp(queuedRequest("Second", firstId, secondId));
      expect(await response.json()).toMatchObject({ runId: secondId, sessionId, queued: true });
      expect(sessionRuns.slice(0, 2).map((run) => run.resumedFromRunId)).toEqual([firstId, parent.id]);
      expect(services.append).not.toHaveBeenCalled();
      expect(services.repair).not.toHaveBeenCalled();
      expect(services.exists).not.toHaveBeenCalled();
      expect(services.enqueue.mock.calls.map(([key]) => key)).toEqual([`session:${sessionId}`, `session:${sessionId}`]);
      const body = await (await GET(request(`?runId=${parent.id}`), context)).json();
      expect(body).toMatchObject({ canQueue: true, queueParentRunId: secondId, queuedMessageCount: 2, pendingPrompt: null });
      expect(body.queuedMessages.map((message: { text: string }) => message.text)).toEqual(["First", "Second"]);
    });

    it("keeps the immutable request idempotent after later messages join the queue", async () => {
      const first = queuedRequest("First", parent.id, "33333333-3333-4333-8333-333333333333");
      const original = await (await followUp(first)).json();
      await followUp(queuedRequest("Second", first.requestId, "44444444-4444-4444-8444-444444444444"));
      expect(await (await followUp(first)).json()).toEqual(original);
      expect(services.create).toHaveBeenCalledTimes(2);
      expect(services.enqueue).toHaveBeenCalledTimes(2);
      expect((await followUp({ ...first, queue: false })).status).toBe(409);
      expect((await followUp({ ...first, prompt: "Changed" })).status).toBe(409);
    });
    it("retains independent SDK Steering while messages wait without invoking immediate transport", async () => {
      parent.engine = "SDK";
      const transport = { send: vi.fn().mockResolvedValue({ messageId: "synthetic" }), abort: vi.fn().mockResolvedValue(undefined) };
      const controller = new ManagedSessionController(transport);
      registerManagedSessionController(parent.id, controller);
      try {
        const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        expect((await followUp(queuedRequest("Later", parent.id, id))).status).toBe(202);
        const body = await (await GET(request(`?runId=${parent.id}`), context)).json();
        expect(body).toMatchObject({ canSteer: true, steeringRunId: parent.id, canQueue: true, queueParentRunId: id, queuedMessageCount: 1 });
        expect(transport.send).not.toHaveBeenCalled();
      } finally {
        unregisterManagedSessionController(parent.id, controller);
      }
    });

    it("requires request identity and an explicit parent, and rejects a stale queue tail", async () => {
      expect((await followUp({ prompt: "Next", queue: true })).status).toBe(400);
      expect((await followUp({ prompt: "Next", queue: true, requestId: "55555555-5555-4555-8555-555555555555" })).status).toBe(400);
      await followUp(queuedRequest("First", parent.id, "66666666-6666-4666-8666-666666666666"));
      expect((await followUp(queuedRequest("Stale", parent.id, "77777777-7777-4777-8777-777777777777"))).status).toBe(409);
      expect(services.create).toHaveBeenCalledOnce();
    });

    it("still blocks other directory owners, sessions, hosts and Terminal Runs", async () => {
      const input = queuedRequest("Next", parent.id, "88888888-8888-4888-8888-888888888888");
      services.conflicts.mockResolvedValueOnce([{ id: "other-directory-owner" }]);
      expect((await followUp(input)).status).toBe(409);
      sessionRuns.unshift({ ...parent, id: "another-session", copilotSessionId: "different-session" });
      expect((await followUp(input)).status).toBe(409);
      sessionRuns.shift();
      parent.hostname = "another-machine";
      expect((await followUp(input)).status).toBe(409);
      parent.hostname = hostname();
      parent.trigger = "TERMINAL_RESUME";
      expect((await followUp(input)).status).toBe(409);
      expect(services.create).not.toHaveBeenCalled();
    });

    it("permits pending managed sessions without prematurely requiring recorded history", async () => {
      parent.status = "PENDING";
      parent.startedAt = null;
      services.nativeActive.mockReturnValue(false);
      services.exists.mockResolvedValue(false);
      const response = await followUp(queuedRequest("Next", parent.id, "99999999-9999-4999-8999-999999999999"));
      expect(response.status).toBe(202);
      expect(services.exists).not.toHaveBeenCalled();
    });

    it("accepts a queue request racing with completion in the same selected session", async () => {
      parent.status = "SUCCESS";
      parent.finishedAt = new Date();
      const response = await followUp(queuedRequest("Next", parent.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
      expect(response.status).toBe(202);
      expect(services.append).not.toHaveBeenCalled();
    });

    it("bounds previews, not queue length, and does not display waiting input as already delivered", async () => {
      let tail = parent.id;
      for (let index = 0; index < 25; index++) {
        const id = `queued-${index}`;
        sessionRuns.unshift({ ...parent, id, status: "PENDING", startedAt: null, finishedAt: null,
          createdAt: new Date(parent.createdAt.getTime() + index + 1), concurrencyMode: "FOLLOW_UP_QUEUED",
          resumedFromRunId: tail, promptSnapshot: "x".repeat(1000) });
        tail = id;
      }
      const body = await (await GET(request(`?runId=${parent.id}`), context)).json();
      expect(body).toMatchObject({ queuedMessageCount: 25, queueParentRunId: tail, pendingPrompt: null });
      expect(body.queuedMessages).toHaveLength(20);
      expect(body.queuedMessages[0]).toMatchObject({ runId: "queued-0", text: `${"x".repeat(500)}...` });
    });

    it("restores a running queued input at execution time, after its predecessor's reply", async () => {
      parent.status = "SUCCESS";
      const startedAt = new Date(parent.createdAt.getTime() + 60_000);
      const queued = { ...parent, id: "started-queue", trigger: "FOLLOW_UP", status: "RUNNING",
        createdAt: new Date(parent.createdAt.getTime() + 1000), startedAt, finishedAt: null,
        concurrencyMode: "FOLLOW_UP_QUEUED", resumedFromRunId: parent.id, promptSnapshot: "Next input" };
      sessionRuns.unshift(queued);
      const body = await (await GET(request("?runId=started-queue"), context)).json();
      expect(body.pendingPrompt).toMatchObject({ runId: queued.id, text: "Next input", timestamp: startedAt.toISOString() });
    });
  });

  it("does not switch the displayed conversation to another parent or missing session", async () => {
    expect((await followUp({ prompt: "Continue", expectedParentRunId: "old-run" })).status).toBe(409);
    services.exists.mockResolvedValue(false);
    expect((await followUp({ prompt: "Continue", expectedParentRunId: "run-1" })).status).toBe(409);
    expect(services.create).not.toHaveBeenCalled();
    expect(services.append).not.toHaveBeenCalled();
  });

  it("does not silently attach an expected new conversation to an existing one", async () => {
    expect((await followUp({ prompt: "First", expectedParentRunId: null })).status).toBe(409);
    expect(services.create).not.toHaveBeenCalled();
  });

  it("blocks physical Terminal ownership and maps a late lock race to conflict", async () => {
    services.activity.mockResolvedValueOnce({ active: true });
    expect((await followUp({ prompt: "Continue", expectedParentRunId: "run-1" })).status).toBe(409);
    services.repair.mockRejectedValueOnce(new CopilotSessionInUseError(process.pid));
    expect((await followUp({ prompt: "Continue", expectedParentRunId: "run-1" })).status).toBe(409);
    expect(services.create).not.toHaveBeenCalled();
  });
});