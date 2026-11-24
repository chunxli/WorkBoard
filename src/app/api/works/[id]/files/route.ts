import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { listCreatedRunFiles, listWorkDirectory, previewWorkFile, WorkDirectoryError } from "@/lib/work-directory-browser";

const querySchema = z.object({
  path: z.string().max(4096).default(""),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  open: z.literal("1").optional(),
  createdInRun: z.string().min(1).max(128).optional(),
}).strict().refine((value) => !(value.open && value.createdInRun), "Cannot combine open and createdInRun.");

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const work = await prisma.work.findFirst({ where: { id, userId }, select: { directoryPath: true } });
  if (!work) return NextResponse.json({ error: "Work not found" }, { status: 404 });
  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid Work file request" }, { status: 400 });
  try {
    if (query.data.createdInRun) {
      const run = await prisma.run.findFirst({
        where: { id: query.data.createdInRun, workId: id, experimentVariantId: null },
        select: { id: true, status: true, executionPath: true, outputDir: true },
      });
      if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
      const createdPaths = run.status === "PENDING" || run.status === "RUNNING"
        ? []
        : await listCreatedRunFiles(work.directoryPath, run);
      return NextResponse.json({ createdPaths }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (query.data.open === "1") return await previewWorkFile(work.directoryPath, query.data.path);
    return NextResponse.json(await listWorkDirectory(work.directoryPath, query.data.path, query.data.offset), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof WorkDirectoryError) return NextResponse.json({ error: error.message }, { status: error.status });
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") return NextResponse.json({ error: "File or folder not found. Refresh to see the current contents." }, { status: 404 });
    if (code === "EACCES" || code === "EPERM") return NextResponse.json({ error: "Permission denied for this Work file or folder." }, { status: 403 });
    console.error("[Work files] Unable to read Work directory", error);
    return NextResponse.json({ error: "Unable to read Work files. Check the server logs." }, { status: 500 });
  }
}
