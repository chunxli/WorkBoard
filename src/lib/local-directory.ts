import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export type LocalDirectoryErrorCode =
  | "invalid_name"
  | "invalid_parent"
  | "already_exists"
  | "permission_denied";

export class LocalDirectoryError extends Error {
  constructor(message: string, readonly code: LocalDirectoryErrorCode) {
    super(message);
    this.name = "LocalDirectoryError";
  }
}

export function validateFolderName(value: string): string {
  const name = value.trim();
  if (!name) throw new LocalDirectoryError("Folder name is required", "invalid_name");
  if (name.length > 255) {
    throw new LocalDirectoryError("Folder name must be 255 characters or fewer", "invalid_name");
  }
  if (name === "." || name === "..") {
    throw new LocalDirectoryError("Choose a different folder name", "invalid_name");
  }
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(name)) {
    throw new LocalDirectoryError("Folder name contains unsupported characters", "invalid_name");
  }
  if (name.endsWith(".")) {
    throw new LocalDirectoryError("Folder name cannot end with a period", "invalid_name");
  }
  if (WINDOWS_RESERVED_NAMES.has(name.split(".", 1)[0].toUpperCase())) {
    throw new LocalDirectoryError("This folder name is reserved by Windows", "invalid_name");
  }
  return name;
}

export async function createChildDirectory(
  parentPath: string,
  requestedName: string
): Promise<string> {
  if (!parentPath.trim()) {
    throw new LocalDirectoryError("Parent directory is required", "invalid_parent");
  }
  const name = validateFolderName(requestedName);
  const parent = path.resolve(parentPath.trim());
  const parentInfo = await stat(parent).catch(() => null);
  if (!parentInfo?.isDirectory()) {
    throw new LocalDirectoryError("Parent directory does not exist", "invalid_parent");
  }

  const destination = path.join(parent, name);
  try {
    await mkdir(destination);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") {
      throw new LocalDirectoryError("A folder with this name already exists", "already_exists");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new LocalDirectoryError("Permission denied while creating folder", "permission_denied");
    }
    throw error;
  }
  return destination;
}