import { NextRequest, NextResponse } from "next/server";
import { hostname } from "node:os";
import { prisma } from "@/lib/prisma";
import { createRepoSchema } from "@/lib/validation";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repos = await prisma.repo.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return NextResponse.json(repos);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = createRepoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const repo = await prisma.repo.create({
      data: { ...parsed.data, userId, hostname: hostname() },
    });
    return NextResponse.json(repo, { status: 201 });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return NextResponse.json(
      { error: code === "P2002" ? "This resource already exists" : "Failed to create resource" },
      { status: code === "P2002" ? 409 : 500 }
    );
  }
}
