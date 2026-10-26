import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkAttachment } from "@/lib/work-attachment-types";
const mocks = vi.hoisted(() => ({
  user: vi.fn(), work: vi.fn(), run: vi.fn(), existing: vi.fn(), create: vi.fn(), prompt: vi.fn(), enqueue: vi.fn(),
  resolve: vi.fn(), conflicts: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { findFirst: mocks.work }, run: { findFirst: mocks.run, findUnique: mocks.existing } } }));
vi.mock("@/lib/work-executor", () => ({
  createPendingFollowUpRun: mocks.create, ensureFollowUpPrompt: mocks.prompt, executeWorkRun: vi.fn(),
  getWorkRunQueueKey: (run: { id: string }) => run.id,
}));
vi.mock("@/lib/job-queue", () => ({ jobQueue: { enqueue: mocks.enqueue } }));
vi.mock("@/lib/run-access", () => ({ findActiveRunConflicts: mocks.conflicts }));
vi.mock("@/lib/work-attachments", async (original) => ({
  ...await original<typeof import("@/lib/work-attachments")>(), resolveWorkAttachments: mocks.resolve,
}));
import { POST } from "./route";
import { WorkAttachmentError } from "@/lib/work-attachments";

describe("Follow Up attachment contract", () => {
  const work = { id: "followup-attachment-work", hostname: hostname(), directoryPath: "C:\\synthetic", status: "ACTIVE" };
  let file: WorkAttachment;
  let stored: Record<string, unknown> | null;
  beforeEach(() => {
    vi.clearAllMocks(); stored = null;
    const id = randomUUID();
    file = { id, requestId: randomUUID(), uploadId: randomUUID(), name: "image.png", storedName: `${id}-image.png`, size: 50, mediaType: "image/png", sha256: "a".repeat(64) };
    mocks.user.mockResolvedValue("owner"); mocks.work.mockResolvedValue(work);
    mocks.run.mockResolvedValue(null); mocks.existing.mockImplementation(async () => stored);
    mocks.conflicts.mockResolvedValue([]); mocks.resolve.mockImplementation(async () => [file]);
    mocks.prompt.mockResolvedValue(undefined);
    mocks.create.mockImplementation(async (options) => {
      stored = { id: options.requestId, workId: options.workId, trigger: "FOLLOW_UP", promptSnapshot: options.prompt,
        attachmentsJson: JSON.stringify(options.attachments), resumedFromRunId: null, copilotSessionId: randomUUID() };
      return stored;
    });
  });
  function post(input: Record<string, unknown>) {
    return POST(new NextRequest("http://localhost/api", { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" } }),
      { params: Promise.resolve({ id: work.id }) });
  }
  it("queues an attachment-only message once and returns the same Run after response loss", async () => {
    const input = { requestId: file.requestId, prompt: "", attachmentIds: [file.id], expectedParentRunId: null };
    const first = await post(input); const original = await first.json();
    expect(first.status).toBe(202);
    expect(mocks.resolve).toHaveBeenCalledWith(work, file.requestId, [file.id], true);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: "", attachments: [file], requestId: file.requestId }));
    mocks.run.mockResolvedValue({ id: original.runId, status: "RUNNING" });
    expect(await (await post(input)).json()).toEqual(original);
    expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect((await post({ ...input, prompt: "changed" })).status).toBe(409);
    expect((await post({ ...input, attachmentIds: [randomUUID()] })).status).toBe(409);
  });
  it("rejects empty drafts, unbound attachments and missing or foreign receipts without creating a Run", async () => {
    expect((await post({ prompt: "" })).status).toBe(400);
    expect((await post({ attachmentIds: [file.id] })).status).toBe(400);
    mocks.resolve.mockRejectedValue(new WorkAttachmentError("Missing attachment", 409));
    expect((await post({ requestId: file.requestId, attachmentIds: [file.id], expectedParentRunId: null })).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("keeps archived, cross-host, stale-session and conflicting Work checks", async () => {
    const input = { requestId: file.requestId, attachmentIds: [file.id], expectedParentRunId: null };
    mocks.work.mockResolvedValueOnce(work).mockResolvedValueOnce({ ...work, status: "ARCHIVED" });
    expect((await post(input)).status).toBe(409);
    mocks.work.mockResolvedValueOnce(work).mockResolvedValueOnce({ ...work, hostname: "another-host" });
    expect((await post(input)).status).toBe(409);
    mocks.conflicts.mockResolvedValueOnce([{ id: "conflicting-run" }]);
    expect((await post(input)).status).toBe(409);
    expect((await post({ ...input, expectedParentRunId: "stale" })).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
