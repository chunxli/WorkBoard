import { hostname } from "node:os";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), work: vi.fn(), run: vi.fn(), page: vi.fn(),
  list: vi.fn(), upsert: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  work: { findFirst: mocks.work }, run: { findFirst: mocks.run },
  workConversationPin: { findMany: mocks.list, upsert: mocks.upsert, deleteMany: mocks.remove },
} }));
vi.mock("@/lib/session-conversation", async (original) => ({
  ...await original<typeof import("@/lib/session-conversation")>(), readSessionConversationPage: mocks.page,
}));
import { GET, POST, DELETE } from "./route";
import { normalizeConversationEvent } from "@/lib/session-conversation";

const sessionId = "12345678-1234-4234-8234-123456789abc";
const event = normalizeConversationEvent({ type: "assistant.message", data: { content: "Paragraph\n\n```xml\n  <sample />\n```" } }, "a".repeat(64), 0)!;
const context = { params: Promise.resolve({ id: "work" }) };
let stored: { id: string; workId: string; sessionId: string; eventId: string; line: number; preview: string; timestamp: string | null; createdAt: Date }[];
const request = (method: string, body?: unknown, query = "runId=run") => new NextRequest(`http://localhost/api/works/work/conversation/pins?${query}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
});

beforeEach(() => {
  vi.resetAllMocks();
  stored = [];
  mocks.user.mockResolvedValue("owner");
  mocks.work.mockResolvedValue({ id: "work", hostname: hostname() });
  mocks.run.mockImplementation(async ({ where }) => where.id === "run" ? { copilotSessionId: sessionId, hostname: hostname() } : null);
  mocks.page.mockResolvedValue({ events: [event] });
  mocks.list.mockImplementation(async ({ where }) => stored.filter((pin) => pin.workId === where.workId && pin.sessionId === where.sessionId));
  mocks.upsert.mockImplementation(async ({ create, where }) => {
    const key = where.workId_sessionId_eventId_line;
    const existing = stored.find((pin) => pin.workId === key.workId && pin.sessionId === key.sessionId && pin.eventId === key.eventId && pin.line === key.line);
    if (existing) return existing;
    const pin = { ...create, id: "saved-pin", createdAt: new Date("2026-11-03T00:00:00Z") };
    stored.push(pin);
    return pin;
  });
  mocks.remove.mockImplementation(async ({ where }) => {
    const oldLength = stored.length;
    stored = stored.filter((pin) => pin.id !== where.id || pin.workId !== where.workId || pin.sessionId !== where.sessionId);
    return { count: oldLength - stored.length };
  });
});

describe("owner-scoped session Pin API", () => {
  it("saves server-verified line previews exactly once and restores them without rereading history", async () => {
    const input = { runId: "run", eventId: event.id, line: 4 };
    const response = await POST(request("POST", input), context);
    expect(response.status).toBe(201);
    const first = await response.json();
    expect(first.pin).toMatchObject({ sessionId, line: 4, preview: "<sample />" });
    expect(await (await POST(request("POST", input), context)).json()).toEqual(first);
    expect(stored).toHaveLength(1);
    expect(mocks.page).toHaveBeenCalledWith(sessionId, { atOffset: 0 });
    mocks.page.mockClear();
    const listed = await GET(request("GET"), context);
    expect(await listed.json()).toEqual({ sessionId, pins: [first.pin] });
    expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("authorizes Work and session ownership before touching pins or local history", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await GET(request("GET"), context)).status).toBe(401);
    mocks.work.mockResolvedValueOnce(null);
    expect((await POST(request("POST", { runId: "run", eventId: event.id, line: 4 }), context)).status).toBe(404);
    mocks.run.mockResolvedValueOnce(null);
    expect((await GET(request("GET"), context)).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.work).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "work", userId: "owner" } }));
  });

  it("rejects foreign-host/shared sessions, unsafe targets and client-supplied preview text", async () => {
    const input = { runId: "run", eventId: event.id, line: 4 };
    mocks.work.mockResolvedValueOnce({ id: "work", hostname: "foreign" });
    expect((await POST(request("POST", input), context)).status).toBe(409);
    mocks.run.mockResolvedValueOnce({ copilotSessionId: sessionId, hostname: hostname() }).mockResolvedValueOnce({ id: "foreign-work-run" });
    expect((await GET(request("GET"), context)).status).toBe(409);
    expect((await POST(request("POST", { ...input, preview: "Spoofed" }), context)).status).toBe(400);
    expect((await POST(request("POST", { ...input, eventId: "../path" }), context)).status).toBe(400);
    expect((await POST(request("POST", { ...input, line: 0 }), context)).status).toBe(400);
    expect((await POST(request("POST", { ...input, line: 2 }), context)).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not pin a changed, unrecorded or user-message target", async () => {
    const input = { runId: "run", eventId: event.id, line: 4 };
    mocks.page.mockResolvedValueOnce({ events: [{ ...event, id: `${"b".repeat(64)}:0` }] });
    expect((await POST(request("POST", input), context)).status).toBe(409);
    mocks.page.mockResolvedValueOnce({ events: [{ ...event, role: "user" }] });
    expect((await POST(request("POST", input), context)).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("makes removal retry-safe while restricting every mutation to the selected Work/session", async () => {
    await POST(request("POST", { runId: "run", eventId: event.id, line: 4 }), context);
    const response = await DELETE(request("DELETE", undefined, "runId=run&pinId=saved-pin"), context);
    expect(await response.json()).toEqual({ removed: true });
    expect(await (await DELETE(request("DELETE", undefined, "runId=run&pinId=saved-pin"), context)).json()).toEqual({ removed: true });
    expect(mocks.remove).toHaveBeenCalledWith({ where: { id: "saved-pin", workId: "work", sessionId } });
    expect(stored).toEqual([]);
    expect((await DELETE(request("DELETE"), context)).status).toBe(400);
  });

  it("does not return success-shaped results when pin storage fails", async () => {
    const error = new Error("Database unavailable");
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.upsert.mockRejectedValueOnce(error);
      const response = await POST(request("POST", { runId: "run", eventId: event.id, line: 4 }), context);
      expect(response.status).toBe(500);
      expect(logger).toHaveBeenCalledWith("[conversation-pins] Request failed:", error);
    } finally { logger.mockRestore(); }
  });
});
