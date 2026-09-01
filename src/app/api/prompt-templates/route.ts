import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { createPromptTemplateSchema } from "@/lib/validation";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const templates = await prisma.promptTemplate.findMany({
    where: { userId },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
  return NextResponse.json(templates);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = createPromptTemplateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const template = await prisma.promptTemplate.create({
      data: {
        userId,
        name: parsed.data.name,
        description: parsed.data.description || null,
        content: parsed.data.content,
      },
    });
    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return NextResponse.json(
      { error: code === "P2002" ? "A template with this name already exists" : "Failed to create template" },
      { status: code === "P2002" ? 409 : 500 }
    );
  }
}