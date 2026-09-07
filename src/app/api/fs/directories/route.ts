import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { createChildDirectory, LocalDirectoryError } from "@/lib/local-directory";

const requestSchema = z.object({
  parentPath: z.string().trim().min(1).max(2000),
  name: z.string().max(255),
}).strict();

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const directoryPath = await createChildDirectory(
      parsed.data.parentPath,
      parsed.data.name
    );
    return NextResponse.json({ path: directoryPath }, { status: 201 });
  } catch (error) {
    const status = error instanceof LocalDirectoryError
      ? error.code === "already_exists"
        ? 409
        : error.code === "permission_denied"
          ? 403
          : 400
      : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create folder" },
      { status }
    );
  }
}