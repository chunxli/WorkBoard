import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES, attachmentPrompt } from "./work-attachment-types";
import { readWorkAttachment, resolveWorkAttachments, runtimeWorkAttachments, saveWorkAttachment } from "./work-attachments";

let root: string;
let work: { id: string; directoryPath: string };
let requestId: string;
const body = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
async function upload(bytes = new Uint8Array([1, 2, 3]), options: Partial<Parameters<typeof saveWorkAttachment>[0]> = {}) {
  return saveWorkAttachment({ work, requestId, uploadId: randomUUID(), name: "sample.txt", size: bytes.length, body: body(bytes), ...options });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "work-attachments-"));
  work = { id: "work-one", directoryPath: root };
  requestId = randomUUID();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Work attachment storage", () => {
  it("keeps Unicode display names while bounding the stored filename on UTF-8 filesystems", async () => {
    const name = "\u4e2d".repeat(80) + ".png";
    const file = await upload(undefined, { name });
    expect(file.name).toBe(name);
    expect(Buffer.byteLength(file.storedName, "utf8")).toBeLessThan(255);
    expect(file.storedName.endsWith(".png")).toBe(true);
    expect((await readWorkAttachment(work, requestId, file.id)).bytes).toEqual(Buffer.from([1, 2, 3]));
  });

  it("stores exact bytes under the namespaced Work/message path and never overwrites duplicate names", async () => {
    const first = await upload(undefined, { name: "中文 image.txt" });
    const second = await upload(undefined, { name: "中文 image.txt" });
    expect(first.storedName).not.toBe(second.storedName);
    expect((await readWorkAttachment(work, requestId, first.id)).bytes).toEqual(Buffer.from([1, 2, 3]));
    expect((await readdir(path.join(root, ".workboard", "attachments", work.id, requestId))).sort())
      .toEqual([first.storedName, second.storedName, "manifest.json"].sort());
  });

  it("is idempotent for upload ID and bytes but rejects changed contents", async () => {
    const uploadId = randomUUID();
    const original = await upload(undefined, { uploadId });
    expect(await upload(undefined, { uploadId })).toEqual(original);
    await expect(upload(new Uint8Array([4, 5, 6]), { uploadId })).rejects.toMatchObject({ status: 409 });
  });

  it("seals message files and preserves server-validated runtime attachment options", async () => {
    const file = await upload();
    await resolveWorkAttachments(work, requestId, [file.id], true);
    await expect(upload()).rejects.toMatchObject({ status: 409 });
    const options = await runtimeWorkAttachments(work, [file]);
    expect(options).toEqual([{ type: "file", displayName: "sample.txt", path: path.join(root, ".workboard", "attachments", work.id, requestId, file.storedName) }]);
    expect(attachmentPrompt("", work.id, [file])).toContain("Please review the attached files.");
    expect(attachmentPrompt("Read it", work.id, [file])).not.toContain(root);
  });

  it("does not mix attachments from Works sharing the same directory", async () => {
    const file = await upload();
    await expect(resolveWorkAttachments({ ...work, id: "another-work" }, requestId, [file.id])).rejects.toThrow();
  });

  it("detects tampered files instead of sending old metadata with new bytes", async () => {
    const file = await upload();
    await writeFile(path.join(root, ".workboard", "attachments", work.id, requestId, file.storedName), new Uint8Array([7, 8, 9]));
    await expect(runtimeWorkAttachments(work, [file])).rejects.toThrow("content changed");
  });

  it("recognizes raster image bytes instead of trusting the filename", async () => {
    const file = await upload(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), { name: "pasted.png" });
    expect(file.mediaType).toBe("image/png");
    expect((await upload(undefined, { name: "not-an-image.png" })).mediaType).toBe("application/octet-stream");
  });

  it("accepts the exact 25 MiB limit and rejects its next byte", async () => {
    const file = await upload(new Uint8Array(MAX_ATTACHMENT_BYTES));
    expect(file.size).toBe(MAX_ATTACHMENT_BYTES);
    await expect(upload(new Uint8Array(1), { size: MAX_ATTACHMENT_BYTES + 1 })).rejects.toMatchObject({ status: 413 });
  });

  it("enforces a total of 100 MiB and ten files, including concurrent submissions", async () => {
    for (let index = 0; index < 4; index++) await upload(new Uint8Array(MAX_ATTACHMENT_BYTES));
    await expect(upload(new Uint8Array(1))).rejects.toMatchObject({ status: 413 });
    requestId = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => upload(new Uint8Array())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it.each(["../outside", "folder\\escape", "folder/escape"])("does not accept a path as filename %s", async (name) => {
    await expect(upload(undefined, { name })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects redirected managed directories", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(root, ".workboard"), process.platform === "win32" ? "junction" : "dir");
    await expect(upload()).rejects.toMatchObject({ status: 403 });
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not issue a receipt for truncated or oversized streams and removes owned partials", async () => {
    await expect(upload(undefined, { size: 4 })).rejects.toMatchObject({ status: 409 });
    await expect(upload(undefined, { size: 2 })).rejects.toMatchObject({ status: 413 });
    expect(await readdir(path.join(root, ".workboard", "attachments", work.id, requestId))).toEqual([]);
  });

  it("can store an empty file and detects an already-aborted upload", async () => {
    expect((await upload(new Uint8Array())).size).toBe(0);
    const controller = new AbortController();
    controller.abort();
    await expect(upload(undefined, { signal: controller.signal })).rejects.toMatchObject({ status: 409 });
  });
});
