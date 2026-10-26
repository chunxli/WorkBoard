import { NextRequest, NextResponse } from "next/server";
import { readdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

async function listWindowsDrives(): Promise<{ name: string; path: string }[]> {
  const drives: { name: string; path: string }[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const drivePath = `${letter}:\\`;
    try {
      await access(drivePath);
      drives.push({ name: drivePath, path: drivePath });
    } catch {
      // Drive letter not in use; skip.
    }
  }
  return drives;
}

async function listRoots(): Promise<{ name: string; path: string }[]> {
  if (process.platform === "win32") return listWindowsDrives();
  return [{ name: "/", path: "/" }];
}

/**
 * Read-only local directory browser for the "Browse local folder" repo picker. This app is a
 * single-user localhost tool that already lets users type arbitrary local paths and clone
 * arbitrary git URLs, so exposing a read-only directory listing isn't a new privilege boundary.
 */
export async function GET(req: NextRequest) {
  const includeFiles = req.nextUrl.searchParams.get("includeFiles");
  if (includeFiles !== null && includeFiles !== "1") {
    return NextResponse.json({ error: "Invalid directory listing option" }, { status: 400, headers });
  }
  const requested = req.nextUrl.searchParams.get("path");
  const roots = await listRoots();
  const current = requested ? path.resolve(requested) : os.homedir();

  try {
    const names = await readdir(current, { withFileTypes: true });
    const entries = names
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: path.join(current, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parentDir = path.dirname(current);
    return NextResponse.json({
      current,
      parent: parentDir !== current ? parentDir : null,
      entries,
      roots,
      ...(includeFiles === "1" ? {
        items: names.map((entry) => ({
          name: entry.name,
          path: path.join(current, entry.name),
          kind: entry.isSymbolicLink() ? "reference" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "reference",
        })).sort((left, right) =>
          Number(right.kind === "directory") - Number(left.kind === "directory") ||
          left.name.localeCompare(right.name)),
      } : {}),
    }, { headers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read directory", current, roots },
      { status: 400, headers }
    );
  }
}
