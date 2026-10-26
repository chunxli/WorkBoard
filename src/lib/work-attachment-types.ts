import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 10;

export const workAttachmentSchema = z.object({
  id: z.string().uuid(),
  uploadId: z.string().uuid(),
  requestId: z.string().uuid(),
  name: z.string().min(1).max(240),
  storedName: z.string().min(1).max(240),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
  mediaType: z.string().max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type WorkAttachment = z.infer<typeof workAttachmentSchema>;
export const workAttachmentsSchema = z.array(workAttachmentSchema).max(MAX_MESSAGE_ATTACHMENTS)
  .refine((files) => files.reduce((total, file) => total + file.size, 0) <= MAX_MESSAGE_ATTACHMENT_BYTES, "Attachments exceed 100 MiB.");

export const attachmentIdsSchema = z.array(z.string().uuid()).max(MAX_MESSAGE_ATTACHMENTS)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate attachment IDs.");

export function attachmentRelativePath(workId: string, file: WorkAttachment): string {
  return `.workboard/attachments/${workId}/${file.requestId}/${file.storedName}`;
}

export function attachmentHref(workId: string, file: WorkAttachment, download = false): string {
  const query = new URLSearchParams({ requestId: file.requestId, attachmentId: file.id, ...(download ? { download: "1" } : {}) });
  return `/api/works/${encodeURIComponent(workId)}/attachments?${query}`;
}

export function attachmentPrompt(text: string, workId: string, files: WorkAttachment[]): string {
  const input = text.trim() || "Please review the attached files.";
  if (!files.length) return input;
  return `${input}\n\nAttachments:\n${files.map((file) =>
    `- ${JSON.stringify(file.name)} (${file.size} bytes): ${attachmentRelativePath(workId, file)}`).join("\n")}`;
}
