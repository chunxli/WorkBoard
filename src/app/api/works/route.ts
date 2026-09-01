import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveRepoWorkdir } from "@/lib/repo-workdir";
import { getSessionUserId } from "@/lib/session";
import { createWorkSchema } from "@/lib/validation";
import {
  provisionWorkDirectory,
  unregisterWorkDirectory,
  WorkFileError,
} from "@/lib/work-files";
import { getUserExecutionDefaults } from "@/lib/user-execution-defaults";
import { workDefaultsPayload } from "@/lib/execution-defaults";

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const view = req.nextUrl.searchParams.get("view");
  const status = view === "archived" ? "ARCHIVED" : view === "all" ? undefined : { not: "ARCHIVED" as const };
  const works = await prisma.work.findMany({
    where: { userId, ...(status ? { status } : {}) },
    orderBy: { updatedAt: "desc" },
    include: {
      sourceRepo: { select: { id: true, name: true } },
      _count: { select: { tasks: true } },
    },
  });
  return NextResponse.json(works);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const defaults = await getUserExecutionDefaults(userId);
  const parsed = createWorkSchema.safeParse({
    ...workDefaultsPayload(defaults),
    ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let sourcePath: string | undefined;
  let sourceRepoId: string | null = null;
  if (parsed.data.initialization === "COPY_PATH") {
    sourcePath = parsed.data.sourcePath ?? undefined;
  } else if (parsed.data.initialization === "COPY_REPO") {
    const repo = await prisma.repo.findFirst({
      where: { id: parsed.data.sourceRepoId ?? "", userId },
    });
    if (!repo) return NextResponse.json({ error: "Source repo not found" }, { status: 404 });
    sourcePath = await resolveRepoWorkdir(repo);
    sourceRepoId = repo.id;
  }

  const workId = randomUUID();
  let diskRecord: Awaited<ReturnType<typeof provisionWorkDirectory>> | null = null;
  try {
    const firstPosition = await prisma.work.aggregate({
      where: { userId, status: { not: "ARCHIVED" } },
      _min: { position: true },
    });
    diskRecord = await provisionWorkDirectory({
      workId,
      name: parsed.data.name,
      directoryPath: parsed.data.directoryPath,
      prompt: parsed.data.prompt,
      sourcePath,
    });
    const work = await prisma.work.create({
      data: {
        id: workId,
        userId,
        sourceRepoId,
        name: parsed.data.name,
        directoryPath: diskRecord.directoryPath,
        canonicalPath: diskRecord.canonicalPath,
        promptFileName: diskRecord.promptFileName,
        promptCache: parsed.data.prompt,
        promptHash: diskRecord.promptHash,
        hostname: hostname(),
        defaultEngine: parsed.data.defaultEngine,
        agent: parsed.data.agent || null,
        model: parsed.data.model || null,
        fallbackModel: parsed.data.fallbackModel || null,
        contextTier: parsed.data.contextTier || null,
        reasoningEffort: parsed.data.reasoningEffort || null,
        permissionMode: parsed.data.permissionMode,
        outputFormat: parsed.data.outputFormat,
        timeoutSeconds: parsed.data.timeoutSeconds,
        position: (firstPosition._min.position ?? 1) - 1,
      },
    });
    return NextResponse.json(work, { status: 201 });
  } catch (error) {
    if (diskRecord) {
      await unregisterWorkDirectory(diskRecord);
    }
    if (error instanceof WorkFileError) {
      const status = ["destination_not_empty", "invalid_manifest"].includes(error.code) ? 409 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "P2002") {
      return NextResponse.json({ error: "This Work already exists" }, { status: 409 });
    }
    console.error("[works] create failed", error);
    return NextResponse.json({ error: "Failed to create Work" }, { status: 500 });
  }
}