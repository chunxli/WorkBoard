import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const PAGE_SIZE = 200;
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

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
  const entries = (await readdir(resolved, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    path: [...safeSegments(relativePath), entry.name].join("/"),
    kind: /[\u0000-\u001f\u007f\\:]/.test(entry.name) || entry.isSymbolicLink()
      ? "unsupported" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unsupported",
  })).sort((left, right) =>
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
