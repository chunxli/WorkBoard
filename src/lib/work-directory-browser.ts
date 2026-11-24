import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isPrivateRuntimePath } from "@/lib/native-runtime-paths";

const PAGE_SIZE = 200;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_CREATED_RUN_FILES = 500;
const HIDDEN_NEW_FILE_SEGMENTS = new Set([".git", ".workboard"]);

export class WorkDirectoryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkDirectoryError";
  }
}

function safeSegments(relativePath: string): string[] {
  if (relativePath === "") return [];
  const segments = relativePath.split("/");
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\\") || /[\u0000-\u001f\u007f]/.test(relativePath) ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new WorkDirectoryError("Use a relative path inside this Work directory.", 400);
  }
  return segments;
}

async function resolveEntry(directoryPath: string, relativePath: string) {
  const segments = safeSegments(relativePath);
  const root = await realpath(directoryPath);
  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new WorkDirectoryError("Symbolic links and redirected folders are not exposed.", 403);
    }
  }
  const resolved = await realpath(candidate);
  if (isPrivateRuntimePath(resolved)) {
    throw new WorkDirectoryError("Private WorkBoard runtime data is not exposed in the file browser.", 403);
  }
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkDirectoryError("The requested entry is outside this Work directory.", 403);
  }
  return { resolved, info: await lstat(resolved) };
}

export async function listWorkDirectory(directoryPath: string, relativePath: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new WorkDirectoryError("Invalid directory page.", 400);
  const { resolved, info } = await resolveEntry(directoryPath, relativePath);
  if (!info.isDirectory()) throw new WorkDirectoryError("The requested entry is not a folder.", 400);
  const entries = (await readdir(resolved, { withFileTypes: true })).filter((entry) =>
    !isPrivateRuntimePath(path.join(resolved, entry.name))).map((entry) => {
    const kind = /[\u0000-\u001f\u007f\\:]/.test(entry.name) || entry.isSymbolicLink()
      ? "unsupported" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unsupported";
    return {
      name: entry.name,
      path: [...safeSegments(relativePath), entry.name].join("/"),
      absolutePath: kind === "unsupported" ? null : path.join(resolved, entry.name),
      kind,
    };
  }).sort((left, right) =>
    Number(right.kind === "directory") - Number(left.kind === "directory") ||
    left.name.localeCompare(right.name, undefined, { numeric: true }));
  const nextOffset = offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null;
  return { entries: entries.slice(offset, offset + PAGE_SIZE), nextOffset, total: entries.length };
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".log", ".json", ".jsonl", ".yaml", ".yml", ".csv", ".xml", ".sql", ".ps1",
  ".sh", ".bat", ".cmd", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css", ".py", ".go",
  ".rs", ".java", ".cs", ".cpp", ".c", ".h", ".ini", ".toml", ".env", ".gitignore", ".patch",
]);

export async function previewWorkFile(directoryPath: string, relativePath: string) {
  const { resolved, info } = await resolveEntry(directoryPath, relativePath);
  if (!info.isFile()) throw new WorkDirectoryError("Only ordinary files can be opened.", 400);
  const file = await open(resolved, "r");
  try {
    const current = await file.stat();
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) {
      throw new WorkDirectoryError("The file changed while opening it. Refresh and retry.", 409);
    }
    if (current.size > MAX_PREVIEW_BYTES) throw new WorkDirectoryError("Files larger than 16 MiB cannot be opened in the browser.", 413);
    const buffer = Buffer.alloc(Math.min(current.size + 1, MAX_PREVIEW_BYTES + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_PREVIEW_BYTES) throw new WorkDirectoryError("Files larger than 16 MiB cannot be opened in the browser.", 413);
    const after = await file.stat();
    if (bytesRead !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs) {
      throw new WorkDirectoryError("The file changed while reading it. Refresh and retry.", 409);
    }
    const extension = path.extname(resolved).toLowerCase();
    const name = path.basename(resolved);
    const text = TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(name.toLowerCase()) || !extension;
    const mime = MIME_TYPES[extension] ?? (text ? "text/plain; charset=utf-8" : "application/octet-stream");
    const encodedName = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(buffer.subarray(0, bytesRead)), {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `${mime === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });
  } finally {
    await file.close();
  }
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.replace(/\t.*$/, "").trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  const inner = trimmed.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < inner.length; index++) {
    const ch = inner[index];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = inner[++index];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && index + 1 < inner.length && inner[index + 1] >= "0" && inner[index + 1] <= "7") {
        octal += inner[++index];
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
    } else {
      const escaped: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
      bytes.push(escaped[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function extractGitHeaderDestination(line: string): string | null {
  const body = line.slice("diff --git ".length).trim();
  if (body.startsWith('"')) {
    const match = body.match(/^"(?:\\.|[^"\\])*"\s+("(?:\\.|[^"\\])*")$/);
    if (!match) return null;
    const target = unquoteGitPath(match[1]);
    return target.startsWith("b/") ? target.slice(2) : null;
  }
  const bIndex = body.indexOf(" b/");
  if (bIndex <= 0) return null;
  const left = body.slice(0, bIndex);
  const right = body.slice(bIndex + 3);
  if (left === `a/${right}`) return right;
  const fallback = body.lastIndexOf(" b/");
  return fallback > 0 ? body.slice(fallback + 3) : null;
}

function normalizeCreatedRelativePath(candidate: string): string | null {
  if (!candidate) return null;
  try {
    const segments = safeSegments(candidate);
    if (!segments.length || segments.some((segment) => HIDDEN_NEW_FILE_SEGMENTS.has(segment.toLowerCase()))) {
      return null;
    }
    return segments.join("/");
  } catch {
    return null;
  }
}

export function extractCreatedPathsFromDiff(diffText: string): string[] {
  if (!diffText) return [];
  const created = new Set<string>();
  const lines = diffText.split(/\r?\n/);
  let gitCandidate: string | null = null;
  let sawDevNullMinus = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      gitCandidate = extractGitHeaderDestination(line);
      sawDevNullMinus = false;
      continue;
    }
    if (line.startsWith("diff --workboard /dev/null ")) {
      gitCandidate = null;
      sawDevNullMinus = false;
      const target = unquoteGitPath(line.slice("diff --workboard /dev/null ".length));
      const normalized = target.startsWith("b/") ? normalizeCreatedRelativePath(target.slice(2)) : null;
      if (normalized) created.add(normalized);
      continue;
    }
    if (gitCandidate !== null && line.startsWith("new file mode ")) {
      const normalized = normalizeCreatedRelativePath(gitCandidate);
      if (normalized) created.add(normalized);
      gitCandidate = null;
      continue;
    }
    if (line === "--- /dev/null" || line.startsWith("--- /dev/null\t")) {
      sawDevNullMinus = true;
      continue;
    }
    if (sawDevNullMinus && line.startsWith("+++ ")) {
      sawDevNullMinus = false;
      const target = unquoteGitPath(line.slice(4));
      const normalized = target.startsWith("b/") ? normalizeCreatedRelativePath(target.slice(2)) : null;
      if (normalized) created.add(normalized);
      continue;
    }
    if (!line.startsWith("index ") && !line.startsWith("similarity ") && !line.startsWith("old mode ")) {
      sawDevNullMinus = false;
    }
  }

  return [...created].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function relativeInsideWorkRoot(workRoot: string, targetPath: string): string | null {
  const relative = path.relative(workRoot, targetPath);
  if (relative === "") return "";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function readBoundedTextFile(filePath: string, maxBytes: number): Promise<string | null> {
  const file = await open(filePath, "r").catch(() => null);
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0) return "";
    const limit = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(limit);
    let read = 0;
    while (read < limit) {
      const { bytesRead } = await file.read(buffer, read, limit - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function listCreatedRunFiles(
  workDirectoryPath: string,
  run: { id: string; executionPath: string | null; outputDir: string | null },
): Promise<string[]> {
  const workRoot = await realpath(workDirectoryPath);
  const executionCandidate = run.executionPath ? await realpath(run.executionPath).catch(() => null) : workRoot;
  if (!executionCandidate) return [];
  const executionPrefix = relativeInsideWorkRoot(workRoot, executionCandidate);
  if (executionPrefix === null) return [];
  if (executionPrefix !== "") {
    const verifiedExecution = await resolveEntry(workDirectoryPath, executionPrefix).catch(() => null);
    if (!verifiedExecution?.info.isDirectory()) return [];
  }

  const outputDirectory = run.outputDir
    ? await realpath(run.outputDir).catch(() => null)
    : path.join(executionCandidate, ".workboard", "outputs", run.id);
  if (!outputDirectory) return [];
  const relativeOutputDir = relativeInsideWorkRoot(workRoot, outputDirectory);
  if (!relativeOutputDir) return [];
  const verifiedDiff = await resolveEntry(workDirectoryPath, `${relativeOutputDir}/diff.patch`).catch(() => null);
  if (!verifiedDiff?.info.isFile()) return [];

  const diffContent = await readBoundedTextFile(verifiedDiff.resolved, MAX_DIFF_SCAN_BYTES);
  if (!diffContent) return [];

  const rawPaths = extractCreatedPathsFromDiff(diffContent).slice(0, MAX_CREATED_RUN_FILES);
  const verified: string[] = [];
  for (const relativeFile of rawPaths) {
    const workRelative = executionPrefix ? `${executionPrefix}/${relativeFile}` : relativeFile;
    const normalized = normalizeCreatedRelativePath(workRelative);
    if (!normalized) continue;
    const entry = await resolveEntry(workDirectoryPath, normalized).catch(() => null);
    if (entry?.info.isFile()) verified.push(normalized);
  }
  return verified;
}
