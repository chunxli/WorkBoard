import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { updateWorkPromptSchema } from "@/lib/validation";
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
    const prompt = await writeWorkPrompt(
      work,
      parsed.data.content,
      parsed.data.expectedHash,
      async (updatedPrompt) => {
        await prisma.work.update({
          where: { id },
          data: { promptCache: updatedPrompt.content, promptHash: updatedPrompt.hash },
        });
      }
    );
    return NextResponse.json(prompt);
  } catch (error) {
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