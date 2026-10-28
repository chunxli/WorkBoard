import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { updateWorkPromptSchema } from "@/lib/validation";
import { attachmentPrompt } from "@/lib/work-attachment-types";
import { resolveWorkAttachments, WorkAttachmentError } from "@/lib/work-attachments";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import {
  readWorkPrompt,
  WorkPromptConflictError,
  writeWorkPrompt,
} from "@/lib/work-files";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const work = await prisma.work.findFirst({ where: { id, userId } });
  if (!work) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    return NextResponse.json(await readWorkPrompt(work));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read prompt" },
      { status: 400 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const work = await prisma.work.findFirst({ where: { id, userId } });
  if (!work) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = updateWorkPromptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const save = async () => {
      let content = parsed.data.content;
      let expectedHash = parsed.data.expectedHash;
      if (parsed.data.initialAttachmentIds !== undefined) {
        if (work.status === "ARCHIVED" || await prisma.run.count({ where: { workId: id } }) > 0) {
          throw new WorkAttachmentError("Initial attachments must be saved before the first Run.", 409);
        }
        const files = await resolveWorkAttachments(work, work.id, parsed.data.initialAttachmentIds);
        content = attachmentPrompt(content, work.id, files);
        if (content.length > 100000) throw new WorkAttachmentError("Prompt with attachment references exceeds 100,000 characters.");
        const current = await readWorkPrompt(work);
        if (current.content === content) expectedHash = current.hash;
        if (current.hash !== expectedHash) throw new WorkPromptConflictError(current.content, current.hash);
      }
      const prompt = await writeWorkPrompt(work, content, expectedHash, async (updatedPrompt) => {
        await prisma.work.update({
          where: { id },
          data: { promptCache: updatedPrompt.content, promptHash: updatedPrompt.hash },
        });
      });
      if (parsed.data.initialAttachmentIds !== undefined) {
        await resolveWorkAttachments(work, work.id, parsed.data.initialAttachmentIds, true);
      }
      return prompt;
    };
    const prompt = parsed.data.initialAttachmentIds === undefined
      ? await save() : await withRunStartLock([`work:${id}`], save);
    return NextResponse.json(prompt);
  } catch (error) {
    if (error instanceof WorkAttachmentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof RunStartInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof WorkPromptConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          currentContent: error.currentContent,
          currentHash: error.currentHash,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save prompt" },
      { status: 400 }
    );
  }
}