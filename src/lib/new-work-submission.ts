import { z } from "zod";
import type { createWorkSchema } from "@/lib/validation";
import type { WorkAttachment } from "@/lib/work-attachment-types";

const createdWorkSchema = z.object({
  id: z.string().uuid(),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const savedPromptSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) });

export interface CreatedWorkDraft {
  id: string;
  promptHash: string;
  attachmentsSaved: boolean;
}

async function responseBody(response: Response, fallback: string): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = z.object({ error: z.string() }).safeParse(body);
    throw new Error(failure.success ? failure.data.error : fallback);
  }
  return body;
}

export async function prepareNewWork(options: {
  payload: z.input<typeof createWorkSchema>;
  previous: CreatedWorkDraft | null;
  hasAttachments: boolean;
  rememberCreated: (work: CreatedWorkDraft) => void;
  upload: (requestId: string, workId: string) => Promise<WorkAttachment[]>;
  fetcher?: typeof fetch;
}): Promise<CreatedWorkDraft> {
  const fetcher = options.fetcher ?? fetch;
  let work = options.previous;
  if (!work) {
    const response = await fetcher("/api/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.payload),
    });
    const parsed = createdWorkSchema.safeParse(await responseBody(response, "Failed to create Work"));
    if (!parsed.success) throw new Error("The server returned an invalid Work creation receipt.");
    work = { ...parsed.data, attachmentsSaved: !options.hasAttachments };
    options.rememberCreated(work);
  }
  if (!work.attachmentsSaved) {
    const files = await options.upload(work.id, work.id);
    const response = await fetcher(`/api/works/${work.id}/prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: options.payload.prompt,
        expectedHash: work.promptHash,
        initialAttachmentIds: files.map((file) => file.id),
      }),
    });
    const parsed = savedPromptSchema.safeParse(await responseBody(response, "Failed to save initial Prompt attachments"));
    if (!parsed.success) throw new Error("The server returned an invalid Prompt save receipt.");
    work = { ...work, promptHash: parsed.data.hash, attachmentsSaved: true };
    options.rememberCreated(work);
  }
  return work;
}
