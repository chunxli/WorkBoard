import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS,
  workAttachmentsSchema, type WorkAttachment,
} from "./work-attachment-types";

export class WorkAttachmentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WorkAttachmentError";
  }
}

interface AttachmentWork { id: string; directoryPath: string }
const manifestSchema = z.object({
  version: z.literal(1), workId: z.string(), requestId: z.string().uuid(),
  sealed: z.boolean(), files: workAttachmentsSchema,
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const globalState = globalThis as unknown as { attachmentWrites?: Map<string, Promise<unknown>> };
const writes = globalState.attachmentWrites ?? new Map<string, Promise<unknown>>();
globalState.attachmentWrites = writes;

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(key);
  const pending = (previous ? previous.then(() => undefined, () => undefined) : Promise.resolve()).then(operation);
  writes.set(key, pending);
  try { return await pending; }
  finally { if (writes.get(key) === pending) writes.delete(key); }
}

function safeIdentity(value: string, uuid = false) {
  if (!(uuid ? z.string().uuid().safeParse(value).success : /^[a-zA-Z0-9_-]{1,128}$/.test(value))) {
    throw new WorkAttachmentError("Invalid attachment identity.");
  }
}

async function batchDirectory(work: AttachmentWork, requestId: string, create = false) {
  safeIdentity(work.id); safeIdentity(requestId, true);
  const root = await realpath(work.directoryPath);
  let current = root;
  for (const segment of [".workboard", "attachments", work.id, requestId]) {
    current = path.join(current, segment);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkAttachmentError("Redirected attachment directories are not allowed.", 403);
    const relative = path.relative(root, await realpath(current));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkAttachmentError("Attachment path is outside this Work.", 403);
    }
  }
  return current;
}

async function readManifest(work: AttachmentWork, requestId: string, directory: string): Promise<Manifest> {
  const file = path.join(directory, "manifest.json");
  let contents: string;
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new WorkAttachmentError("Redirected attachment metadata is not allowed.", 403);
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workId: work.id, requestId, sealed: false, files: [] };
    throw error;
  }
  const parsed = manifestSchema.safeParse(JSON.parse(contents));
  if (!parsed.success || parsed.data.workId !== work.id || parsed.data.requestId !== requestId) {
    throw new WorkAttachmentError("Attachment metadata is invalid or belongs to another Work.", 409);
  }
  for (const entry of parsed.data.files) {
    if (entry.requestId !== requestId || entry.storedName !== path.basename(entry.storedName) ||
      /[\\/:<>"|?*\u0000-\u001f]/.test(entry.storedName) || !entry.storedName.startsWith(`${entry.id}-`)) {
      throw new WorkAttachmentError("Attachment metadata contains an invalid path.", 409);
    }
  }
  return parsed.data;
}

async function writeManifest(directory: string, manifest: Manifest) {
  const file = path.join(directory, "manifest.json");
  const temporary = path.join(directory, `${randomUUID()}.manifest.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(manifest)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}

function displayName(value: string) {
  const name = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!name || name.length > 180 || /[\\/]/.test(name)) throw new WorkAttachmentError("Use a filename of at most 180 characters without path separators.");
  return name;
}

function rasterMedia(prefix: Buffer): string {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(prefix.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

export async function saveWorkAttachment(options: {
  work: AttachmentWork; requestId: string; uploadId: string; name: string; size: number;
  body: ReadableStream<Uint8Array> | null; signal?: AbortSignal;
}): Promise<WorkAttachment> {
  safeIdentity(options.uploadId, true);
  const name = displayName(options.name);
  if (!Number.isSafeInteger(options.size) || options.size < 0 || options.size > MAX_ATTACHMENT_BYTES) {
    throw new WorkAttachmentError("Each attachment must be at most 25 MiB.", 413);
  }
  return serialize(`${options.work.id}:${options.requestId}`, async () => {
    const directory = await batchDirectory(options.work, options.requestId, true);
    const manifest = await readManifest(options.work, options.requestId, directory);
    const existing = manifest.files.find((entry) => entry.uploadId === options.uploadId);
    if (manifest.sealed && !existing) throw new WorkAttachmentError("This message's attachment set is already frozen.", 409);
    if (!existing && (manifest.files.length >= MAX_MESSAGE_ATTACHMENTS ||
      manifest.files.reduce((sum, file) => sum + file.size, options.size) > MAX_MESSAGE_ATTACHMENT_BYTES)) {
      throw new WorkAttachmentError("A message supports at most 10 files and 100 MiB of attachments.", 413);
    }
    const id = existing?.id ?? randomUUID();
    let safeName = name.replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/g, "") || "attachment";
    while (Buffer.byteLength(safeName, "utf8") > 180) {
      const extension = path.extname(safeName);
      const stem = safeName.slice(0, safeName.length - extension.length);
      safeName = [...stem].slice(0, -1).join("") + extension;
    }
    const storedName = `${id}-${safeName}`;
    const temporary = path.join(directory, `${randomUUID()}.upload.tmp`);
    const file = await open(temporary, "wx", 0o600);
    let total = 0;
    let prefix = Buffer.alloc(0);
    const hash = createHash("sha256");
    const reader = options.body?.getReader();
    try {
      if (options.size && !reader) throw new WorkAttachmentError("Attachment body is missing.");
      for (;;) {
        if (options.signal?.aborted) throw new WorkAttachmentError("Attachment upload was cancelled.", 409);
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        total += chunk.value.byteLength;
        if (total > options.size || total > MAX_ATTACHMENT_BYTES) throw new WorkAttachmentError("Attachment exceeds its declared size or 25 MiB.", 413);
        const bytes = Buffer.from(chunk.value);
        hash.update(bytes);
        if (prefix.length < 12) prefix = Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.length)]);
        let written = 0;
        while (written < bytes.length) written += (await file.write(bytes, written)).bytesWritten;
      }
      if (total !== options.size) throw new WorkAttachmentError("Attachment upload was incomplete. Retry this same file.", 409);
      const sha256 = hash.digest("hex");
      await file.sync();
      await file.close();
      if (existing) {
        if (existing.name !== name || existing.size !== total || existing.sha256 !== sha256) {
          throw new WorkAttachmentError("This upload ID already refers to different attachment content.", 409);
        }
        return existing;
      }
      await batchDirectory(options.work, options.requestId);
      const destination = path.join(directory, storedName);
      const destinationFile = await open(destination, "wx", 0o600);
      await destinationFile.close();
      await rename(temporary, destination);
      const attachment: WorkAttachment = {
        id, uploadId: options.uploadId, requestId: options.requestId, name, storedName,
        size: total, mediaType: rasterMedia(prefix), sha256,
      };
      try { await writeManifest(directory, { ...manifest, files: [...manifest.files, attachment] }); }
      catch (error) { await unlink(destination); throw error; }
      return attachment;
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await file.close();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  });
}

export async function resolveWorkAttachments(work: AttachmentWork, requestId: string, ids: string[], seal = false): Promise<WorkAttachment[]> {
  if (new Set(ids).size !== ids.length || ids.length > MAX_MESSAGE_ATTACHMENTS) throw new WorkAttachmentError("Invalid attachment set.");
  return serialize(`${work.id}:${requestId}`, async () => {
    const directory = await batchDirectory(work, requestId);
    const manifest = await readManifest(work, requestId, directory);
    const files = ids.map((id) => {
      const file = manifest.files.find((entry) => entry.id === id);
      if (!file) throw new WorkAttachmentError("An attachment is missing or belongs to another message.", 409);
      return file;
    });
    if (manifest.sealed && JSON.stringify(manifest.files.map((file) => file.id)) !== JSON.stringify(ids)) {
      throw new WorkAttachmentError("This message's attachment set is already frozen.", 409);
    }
    for (const file of files) await verifyFile(work, file, directory);
    if (seal && !manifest.sealed) await writeManifest(directory, { ...manifest, sealed: true, files });
    return files;
  }).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") throw new WorkAttachmentError("A saved attachment is no longer available. The message was not sent.", 409);
    if (code === "EACCES" || code === "EPERM") throw new WorkAttachmentError("A saved attachment cannot be read. The message was not sent.", 403);
    throw error;
  });
}

async function verifyFile(work: AttachmentWork, attachment: WorkAttachment, directory: string, capture = false) {
  const filePath = path.join(directory, attachment.storedName);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== attachment.size) throw new WorkAttachmentError("A saved attachment changed. It was not sent.", 409);
  const file = await open(filePath, "r");
  const chunks: Buffer[] = [];
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev) throw new WorkAttachmentError("A saved attachment changed while opening.", 409);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > attachment.size) throw new WorkAttachmentError("A saved attachment grew during validation.", 409);
      hash.update(chunk);
      if (capture) chunks.push(chunk);
    }
    if (hash.digest("hex") !== attachment.sha256) throw new WorkAttachmentError("A saved attachment's content changed. It was not sent.", 409);
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new WorkAttachmentError("A saved attachment changed during validation.", 409);
  } finally { await file.close(); }
  await batchDirectory(work, attachment.requestId);
  return Buffer.concat(chunks);
}

export function parseWorkAttachments(value?: string | null): WorkAttachment[] {
  if (!value) return [];
  const parsed = workAttachmentsSchema.safeParse(JSON.parse(value));
  if (!parsed.success) throw new WorkAttachmentError("Stored message attachment metadata is invalid.", 409);
  return parsed.data;
}

export async function runtimeWorkAttachments(work: AttachmentWork, files: WorkAttachment[]) {
  if (!files.length) return [];
  const requestId = files[0].requestId;
  if (files.some((file) => file.requestId !== requestId)) throw new WorkAttachmentError("Attachments must belong to one message.", 409);
  const saved = await resolveWorkAttachments(work, requestId, files.map((file) => file.id));
  if (JSON.stringify(saved) !== JSON.stringify(files)) throw new WorkAttachmentError("Saved attachment metadata changed.", 409);
  const directory = await batchDirectory(work, requestId);
  return saved.map((file) => ({
    type: "file" as const, path: path.join(directory, file.storedName), displayName: file.name,
  }));
}

export async function readWorkAttachment(work: AttachmentWork, requestId: string, id: string) {
  safeIdentity(id, true);
  const directory = await batchDirectory(work, requestId);
  const manifest = await readManifest(work, requestId, directory);
  const attachment = manifest.files.find((file) => file.id === id);
  if (!attachment) throw new WorkAttachmentError("Attachment not found.", 404);
  return { attachment, bytes: await verifyFile(work, attachment, directory, true) };
}
