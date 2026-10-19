import { hostname } from "node:os";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  user: vi.fn(), work: { findFirst: vi.fn() }, run: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  steering: { findMany: vi.fn(), updateMany: vi.fn() },
  conflicts: vi.fn(), activity: vi.fn(), reconcile: vi.fn(), exists: vi.fn(), repair: vi.fn(),
  history: vi.fn(), create: vi.fn(), append: vi.fn(), execute: vi.fn(), enqueue: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { work: services.work, run: services.run, workSteeringMessage: services.steering },
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

import { GET } from "../app/api/works/[id]/conversation/route";
import { POST } from "../app/api/works/[id]/follow-up/route";
import { CopilotSessionInUseError } from "./copilot-session-compat";
import { ConversationReadError } from "./session-conversation";

const sessionId = "12345678-1234-4234-8234-123456789abc";
let parent: {
  id: string; workId: string; status: string; trigger: string; hostname: string;
  copilotSessionId: string; executionPath: string; createdAt: Date; startedAt: Date;
  finishedAt: Date; terminalLaunches: { id: string }[];
};
const context = { params: Promise.resolve({ id: "work-1" }) };
const request = (query = "") => new NextRequest(`http://localhost/api/works/work-1/conversation${query}`);
const followUp = (body: unknown) => POST(new NextRequest("http://localhost/api/works/work-1/follow-up", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), context);

beforeEach(() => {
  vi.resetAllMocks();
  parent = { id: "run-1", workId: "work-1", status: "SUCCESS", trigger: "WORK", hostname: hostname(),
    copilotSessionId: sessionId, executionPath: "C:/example", createdAt: new Date(), startedAt: new Date(), finishedAt: new Date(), terminalLaunches: [] };
  services.user.mockResolvedValue("owner");
  services.work.findFirst.mockResolvedValue({ id: "work-1", hostname: hostname(), status: "ACTIVE", directoryPath: "C:/example", promptFileName: "PROMPT.md", promptHash: "hash" });
  services.run.findFirst.mockImplementation(async ({ where }) => {
    if (where.copilotSessionId && where.OR) return null;
    if (where.status?.in) return null;
    if (where.id && typeof where.id === "string" && where.id !== parent.id) return null;
    return parent;
  });
  services.run.findMany.mockImplementation(async () => [parent]);
  services.run.findUnique.mockResolvedValue(null);
  services.steering.findMany.mockResolvedValue([]);
  services.steering.updateMany.mockResolvedValue({ count: 0 });
  services.conflicts.mockResolvedValue([]);
  services.activity.mockResolvedValue({ active: false, starting: false, wrapperExited: true, exitCode: null });
  services.exists.mockResolvedValue(true);
  services.repair.mockResolvedValue({ repairedEvents: 0, eventCount: 1, backupPath: null });
  services.history.mockResolvedValue({ events: [], nextCursor: "next", previousCursor: null,
    hasMore: false, hasEarlier: false, incompleteTail: false, revision: "revision", generation: "source", sourceBytes: 100 });
  services.create.mockResolvedValue({ id: "follow-up-run", copilotSessionId: sessionId, promptSnapshot: "Continue", createdAt: new Date() });
});

describe("owned session conversation API", () => {
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
    services.run.findMany.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({ ...parent, id: `run-${index}` })));
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
  it("appends accepted input to Prompt once per Run and queues the same session", async () => {
    const response = await followUp({ prompt: "Continue", expectedParentRunId: "run-1" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: "follow-up-run", sessionId, resumed: true });
    expect(services.create).toHaveBeenCalledWith({ workId: "work-1", prompt: "Continue", parentRunId: "run-1" });
    expect(services.append).toHaveBeenCalledWith(expect.objectContaining({ id: "work-1" }), expect.objectContaining({ id: "follow-up-run" }));
    expect(services.enqueue).toHaveBeenCalledWith("session:test", expect.any(Function));
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