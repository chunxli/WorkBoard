import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

const TEXT_CAPTURE_LIMIT = 1024 * 1024;

interface DirectorySnapshotEntry {
  kind: "file" | "symlink";
  size: number;
  sha256: string;
  text?: string;
}

export interface DirectorySnapshot {
  schemaVersion: 1;
  entries: Record<string, DirectorySnapshotEntry>;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function decodeText(content: Buffer): string | undefined {
  if (content.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

export async function captureDirectorySnapshot(rootPath: string): Promise<DirectorySnapshot> {
  const entries: Record<string, DirectorySnapshotEntry> = {};

  async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!relativeDirectory && child.name === ".workboard") continue;
      const absolutePath = path.join(directoryPath, child.name);
      const relativePath = path.join(relativeDirectory, child.name).replaceAll("\\", "/");
      const info = await lstat(absolutePath).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        entries[relativePath] = {
          kind: "symlink",
          size: Buffer.byteLength(target),
          sha256: createHash("sha256").update(target).digest("hex"),
          text: target,
        };
      } else if (info.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        const entry: DirectorySnapshotEntry = {
          kind: "file",
          size: info.size,
          sha256: await hashFile(absolutePath),
        };
        if (info.size <= TEXT_CAPTURE_LIMIT) {
          entry.text = decodeText(await readFile(absolutePath));
        }
        entries[relativePath] = entry;
      }
    }
  }

  await visit(rootPath, "");
  return { schemaVersion: 1, entries };
}

function displayPath(relativePath: string, side: "a" | "b", exists: boolean): string {
  return exists ? `${side}/${relativePath}` : "/dev/null";
}

export function createDirectorySnapshotDiff(
  before: DirectorySnapshot,
  after: DirectorySnapshot
): string {
  const paths = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort();
  const patches: string[] = [];
  for (const relativePath of paths) {
    const previous = before.entries[relativePath];
    const current = after.entries[relativePath];
    if (previous?.sha256 === current?.sha256 && previous?.kind === current?.kind) continue;

    if ((!previous || previous.text !== undefined) && (!current || current.text !== undefined)) {
      patches.push(
        createTwoFilesPatch(
          displayPath(relativePath, "a", Boolean(previous)),
          displayPath(relativePath, "b", Boolean(current)),
          previous?.text ?? "",
          current?.text ?? "",
          previous?.sha256 ?? "new file",
          current?.sha256 ?? "deleted file",
          { context: 3 }
        )
      );
    } else {
      patches.push(
        [
          `diff --workboard ${displayPath(relativePath, "a", Boolean(previous))} ${displayPath(relativePath, "b", Boolean(current))}`,
          `Binary or large file changed: ${previous?.sha256 ?? "missing"} -> ${current?.sha256 ?? "missing"}`,
          "",
        ].join("\n")
      );
    }
  }
  return patches.join("\n");
}

export function getDirectorySnapshotPath(workDirectory: string, runId: string): string {
  return path.join(workDirectory, ".workboard", "tmp", "run-snapshots", `${runId}.json`);
}

export async function writeDirectorySnapshot(
  filePath: string,
  snapshot: DirectorySnapshot
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  await rm(filePath, { force: true });
  await rename(temporaryPath, filePath);
}

export async function readDirectorySnapshot(filePath: string): Promise<DirectorySnapshot> {
  return JSON.parse(await readFile(filePath, "utf8")) as DirectorySnapshot;
}

export async function removeDirectorySnapshot(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}