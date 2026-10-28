import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashWorkContent, provisionWorkDirectory, readWorkPrompt } from "@/lib/work-files";
import { readInitialWorkAttachments, saveWorkAttachment } from "@/lib/work-attachments";
import { attachmentRelativePath } from "@/lib/work-attachment-types";
import { withRunStartLock } from "@/lib/run-start-lock";

const mocks = vi.hoisted(() => ({ user: vi.fn(), work: vi.fn(), update: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  work: { findFirst: mocks.work, update: mocks.update }, run: { count: mocks.count },
} }));
import { PUT } from "./route";

let root: string;
let work: { id: string; directoryPath: string; promptFileName: string; promptHash: string; status: string; hostname: string };
const original = "Review the evidence";
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-initial-prompt-"));
  const record = await provisionWorkDirectory({ workId: randomUUID(), name: "Synthetic work", directoryPath: root, prompt: original });
  work = { ...record, status: "ACTIVE", hostname: hostname() };
  mocks.user.mockResolvedValue("owner");
  mocks.work.mockResolvedValue(work);
  mocks.update.mockResolvedValue(work);
  mocks.count.mockResolvedValue(0);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function save(extra: Record<string, unknown> = {}) {
  return PUT(new NextRequest(`http://localhost/api/works/${work.id}/prompt`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: original, expectedHash: work.promptHash, ...extra }),
  }), { params: Promise.resolve({ id: work.id }) });
}
async function upload() {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  return saveWorkAttachment({
    work, requestId: work.id, uploadId: randomUUID(), name: "pasted.png", size: bytes.length,
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  });
}

describe("initial Prompt attachment finalization", () => {
  it("keeps ordinary Prompt edits unchanged", async () => {
    const response = await save({ content: "Edited Prompt" });
    expect(response.status).toBe(200);
    expect((await readWorkPrompt(work)).content).toBe("Edited Prompt");
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("saves image bytes, appends relative references, seals metadata and updates the Prompt cache", async () => {
    const file = await upload();
    const response = await save({ initialAttachmentIds: [file.id] });
    expect(response.status).toBe(200);
    const prompt = await response.json();
    expect(prompt.content).toContain(attachmentRelativePath(work.id, file));
    expect(prompt.content).not.toContain(root);
    expect(prompt.hash).toBe(hashWorkContent(prompt.content));
    expect(await readFile(path.join(root, work.promptFileName), "utf8")).toBe(prompt.content);
    expect(await readInitialWorkAttachments(work)).toEqual([file]);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: work.id }, data: { promptCache: prompt.content, promptHash: prompt.hash } });
  });

  it("allows exact-draft retries after Prompt writing but before the save receipt arrives", async () => {
    const file = await upload();
    mocks.update.mockRejectedValueOnce(new Error("Synthetic cache failure"));
    expect((await save({ initialAttachmentIds: [file.id] })).status).toBe(400);
    await expect(readInitialWorkAttachments(work)).rejects.toThrow("Finish saving");
    const response = await save({ initialAttachmentIds: [file.id] });
    expect(response.status).toBe(200);
    const { content } = await response.json();
    expect(content.match(/Attachments:/g)).toHaveLength(1);
  });

  it("preserves conflict detection and does not seal attachments when the Prompt was edited elsewhere", async () => {
    const file = await upload();
    const response = await save({ expectedHash: "0".repeat(64), initialAttachmentIds: [file.id] });
    expect(response.status).toBe(409);
    expect((await readWorkPrompt(work)).content).toBe(original);
    await expect(readInitialWorkAttachments(work)).rejects.toThrow("Finish saving");
  });

  it("does not finalize attachments while a Run is already being started", async () => {
    const file = await upload();
    await withRunStartLock([`work:${work.id}`], async () => {
      const response = await save({ initialAttachmentIds: [file.id] });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("already being started");
    });
    expect((await readWorkPrompt(work)).content).toBe(original);
    await expect(readInitialWorkAttachments(work)).rejects.toThrow("Finish saving");
  });

  it("requires authentication and ownership and rejects attachment changes after the first Run", async () => {
    mocks.user.mockResolvedValueOnce(null);
    expect((await save()).status).toBe(401);
    mocks.work.mockResolvedValueOnce(null);
    expect((await save()).status).toBe(404);
    const file = await upload();
    mocks.count.mockResolvedValueOnce(1);
    expect((await save({ initialAttachmentIds: [file.id] })).status).toBe(409);
    work.status = "ARCHIVED";
    expect((await save({ initialAttachmentIds: [file.id] })).status).toBe(409);
    expect(mocks.work).toHaveBeenCalledWith({ where: { id: work.id, userId: "owner" } });
  });

  it("rejects missing receipts and enforces the full Prompt length including attachment references", async () => {
    const file = await upload();
    expect((await save({ initialAttachmentIds: [randomUUID()] })).status).toBe(409);
    expect((await save({ content: "x".repeat(100000), initialAttachmentIds: [file.id] })).status).toBe(400);
    expect((await save({ initialAttachmentIds: [file.id, file.id] })).status).toBe(400);
  });
});
