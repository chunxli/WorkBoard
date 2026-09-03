import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import {
  listDirectoryPromptFiles,
  readDirectoryPromptFile,
  WorkFileError,
} from "@/lib/work-files";

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const directoryPath = req.nextUrl.searchParams.get("path")?.trim();
  const promptFileName = req.nextUrl.searchParams.get("file")?.trim();
  if (!directoryPath) {
    return NextResponse.json({ error: "A Work directory is required" }, { status: 400 });
  }

  try {
    if (promptFileName) {
      return NextResponse.json(
        await readDirectoryPromptFile(directoryPath, promptFileName)
      );
    }
    return NextResponse.json({ files: await listDirectoryPromptFiles(directoryPath) });
  } catch (error) {
    if (error instanceof WorkFileError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "prompt_too_large" ? 413 : 400 }
      );
    }
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return NextResponse.json(
      { error: code === "ENOENT" ? "Prompt file not found" : "Failed to read Prompt file" },
      { status: code === "ENOENT" ? 404 : 500 }
    );
  }
}