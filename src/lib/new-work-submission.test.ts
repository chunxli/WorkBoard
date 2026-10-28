import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareNewWork, type CreatedWorkDraft } from "./new-work-submission";
import type { WorkAttachment } from "./work-attachment-types";

const id = randomUUID();
const payload = { name: "Synthetic work", directoryPath: "C:\\synthetic\\work", prompt: "Review evidence" };
const initialHash = "a".repeat(64);
const finalHash = "b".repeat(64);
const file: WorkAttachment = {
  id: randomUUID(), uploadId: randomUUID(), requestId: id, name: "evidence.png",
  storedName: "synthetic.png", size: 12, mediaType: "image/png", sha256: "c".repeat(64),
};
const fetcher = vi.fn<typeof fetch>();
const upload = vi.fn<Parameters<typeof prepareNewWork>[0]["upload"]>();
let remembered: CreatedWorkDraft | null;
const rememberCreated = vi.fn((work: CreatedWorkDraft) => { remembered = work; });
beforeEach(() => {
  vi.resetAllMocks();
  remembered = null;
  fetcher.mockResolvedValueOnce(Response.json({ id, promptHash: initialHash }, { status: 201 }))
    .mockImplementation(async () => Response.json({ hash: finalHash }));
  upload.mockResolvedValue([file]);
});
const prepare = (hasAttachments = true) => prepareNewWork({
  payload, hasAttachments, previous: remembered, rememberCreated, upload, fetcher,
});

describe("New Work attachment creation ordering and retries", () => {
  it("preserves JSON-only creation without uploading or rewriting a plain Prompt", async () => {
    expect(await prepare(false)).toEqual({ id, promptHash: initialHash, attachmentsSaved: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
  });

  it("creates the Work, uploads into its initial batch, then finalizes the saved Prompt", async () => {
    expect(await prepare()).toEqual({ id, promptHash: finalHash, attachmentsSaved: true });
    expect(upload).toHaveBeenCalledExactlyOnceWith(id, id);
    expect(upload.mock.invocationCallOrder[0]).toBeGreaterThan(rememberCreated.mock.invocationCallOrder[0]);
    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/works/${id}/prompt`, expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ content: payload.prompt, expectedHash: initialHash, initialAttachmentIds: [file.id] }),
    }));
    expect(fetcher.mock.invocationCallOrder[1]).toBeGreaterThan(upload.mock.invocationCallOrder[0]);
  });

  it("retains the created Work after upload failure and retries without a duplicate Work", async () => {
    upload.mockRejectedValueOnce(new Error("Upload interrupted"));
    await expect(prepare()).rejects.toThrow("Upload interrupted");
    expect(remembered).toEqual({ id, promptHash: initialHash, attachmentsSaved: false });
    await prepare();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/works")).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("retries Prompt finalization against the same Work and hash, then skips it once saved", async () => {
    fetcher.mockReset()
      .mockResolvedValueOnce(Response.json({ id, promptHash: initialHash }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: "Save interrupted" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ hash: finalHash }));
    await expect(prepare()).rejects.toThrow("Save interrupted");
    await prepare();
    await prepare();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/works")).toHaveLength(1);
    expect(remembered?.attachmentsSaved).toBe(true);
  });

  it("does not upload after a rejected or invalid Work receipt", async () => {
    fetcher.mockReset().mockResolvedValueOnce(Response.json({ error: "Path denied" }, { status: 400 }));
    await expect(prepare()).rejects.toThrow("Path denied");
    expect(upload).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(Response.json({ id: "invalid" }, { status: 201 }));
    await expect(prepare()).rejects.toThrow("invalid Work creation receipt");
    expect(remembered).toBeNull();
  });

  it("does not report success when the finalization receipt is invalid", async () => {
    fetcher.mockReset()
      .mockResolvedValueOnce(Response.json({ id, promptHash: initialHash }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ content: "missing hash" }));
    await expect(prepare()).rejects.toThrow("invalid Prompt save receipt");
    expect(remembered?.attachmentsSaved).toBe(false);
  });
});
