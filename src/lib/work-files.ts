import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const WORKBOARD_DIRECTORY = ".workboard";
const INDEX_SCHEMA_VERSION = 1;
const MAX_WORK_PROMPT_CHARACTERS = 100_000;
const READABLE_PROMPT_FILE_PATTERN = /^PROMPT(?:\.md|-\d+\.md)?$/i;
const globalForWorkFiles = globalThis as unknown as {
  workPromptWriteQueues?: Map<string, Promise<unknown>>;
  workProvisionQueues?: Map<string, Promise<unknown>>;
};
const promptWriteQueues = globalForWorkFiles.workPromptWriteQueues ?? new Map<string, Promise<unknown>>();
const provisionQueues = globalForWorkFiles.workProvisionQueues ?? new Map<string, Promise<unknown>>();
globalForWorkFiles.workPromptWriteQueues = promptWriteQueues;
globalForWorkFiles.workProvisionQueues = provisionQueues;

interface WorkIndexEntry {
  id: string;
  name: string;
  promptFileName: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkIndex {
  schemaVersion: number;
  works: WorkIndexEntry[];
}

export interface WorkDiskRecord {
  id: string;
  name: string;
  directoryPath: string;
  canonicalPath: string;
  promptFileName: string;
  promptHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkPromptState {
  content: string;
  hash: string;
  modifiedAt: string;
}

export interface DirectoryPromptFile {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface AppendWorkFollowUpOptions {
  createdAt?: Date;
  followUpId?: string;
  afterWrite?: (prompt: WorkPromptState) => Promise<void>;
}

export class WorkFileError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "WorkFileError";
  }
}

export class WorkPromptConflictError extends WorkFileError {
  constructor(
    readonly currentContent: string,
    readonly currentHash: string
  ) {
    super("prompt_conflict", "PROMPT.md changed outside Work Board");
    this.name = "WorkPromptConflictError";
  }
}

export function hashWorkContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function resolveWorkDirectory(directoryPath: string): string {
  const trimmed = directoryPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new WorkFileError("invalid_path", "Work directory must be an absolute path");
  }
  return path.resolve(/* turbopackIgnore: true */ trimmed);
}

export function canonicalizeWorkPath(directoryPath: string): string {
  const resolved = resolveWorkDirectory(directoryPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(
    canonicalizeWorkPath(parentPath),
    canonicalizeWorkPath(candidatePath)
  );
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

async function copyLinkedWorktree(source: string, destination: string): Promise<void> {
  const commonGitDirectory = (
    await runCommand("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], source)
  ).trim();
  const sourceHead = (await runCommand("git", ["rev-parse", "HEAD"], source)).trim();
  await runCommand(
    "git",
    ["clone", "--no-hardlinks", "--no-checkout", commonGitDirectory, destination],
    path.dirname(destination)
  );
  await copyDirectoryEntries(
    source,
    destination,
    new Set([WORKBOARD_DIRECTORY, ".git"])
  );
  await runCommand("git", ["reset", "--mixed", sourceHead], destination);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  }
}

function getBoardPath(directoryPath: string): string {
  return path.join(directoryPath, WORKBOARD_DIRECTORY);
}

function getIndexPath(directoryPath: string): string {
  return path.join(getBoardPath(directoryPath), "index.json");
}

function getWorkManifestPath(directoryPath: string, workId: string): string {
  return path.join(getBoardPath(directoryPath), "works", `${workId}.json`);
}

function getPromptPath(directoryPath: string, promptFileName: string): string {
  if (
    path.basename(promptFileName) !== promptFileName ||
    !/^PROMPT(?:-\d+)?\.md$/i.test(promptFileName)
  ) {
    throw new WorkFileError("invalid_prompt_path", "Invalid Work prompt file name");
  }
  return path.join(directoryPath, promptFileName);
}

function getReadablePromptPath(directoryPath: string, promptFileName: string): string {
  if (
    path.basename(promptFileName) !== promptFileName ||
    !READABLE_PROMPT_FILE_PATTERN.test(promptFileName)
  ) {
    throw new WorkFileError("invalid_prompt_path", "Invalid Prompt file name");
  }
  return path.join(directoryPath, promptFileName);
}

function promptFileOrder(fileName: string): number {
  if (/^PROMPT$/i.test(fileName)) return -1;
  const match = /^PROMPT(?:-(\d+))?\.md$/i.exec(fileName);
  return match?.[1] ? Number(match[1]) : 0;
}

export async function listDirectoryPromptFiles(
  directoryPath: string
): Promise<DirectoryPromptFile[]> {
  const directory = resolveWorkDirectory(directoryPath);
  const directoryInfo = await stat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory()) {
    throw new WorkFileError("invalid_path", "Work path is not an accessible directory");
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const promptFiles = entries.filter(
    (entry) => entry.isFile() && READABLE_PROMPT_FILE_PATTERN.test(entry.name)
  );
  const files = await Promise.all(
    promptFiles.map(async (entry) => {
      const fileInfo = await stat(getReadablePromptPath(directory, entry.name));
      return {
        name: entry.name,
        size: fileInfo.size,
        modifiedAt: fileInfo.mtime.toISOString(),
      };
    })
  );
  return files.sort(
    (left, right) =>
      promptFileOrder(left.name) - promptFileOrder(right.name) ||
      left.name.localeCompare(right.name)
  );
}

export async function readDirectoryPromptFile(
  directoryPath: string,
  promptFileName: string
): Promise<DirectoryPromptFile & { content: string }> {
  const directory = resolveWorkDirectory(directoryPath);
  const promptPath = getReadablePromptPath(directory, promptFileName);
  const fileInfo = await lstat(promptPath);
  if (!fileInfo.isFile()) {
    throw new WorkFileError("invalid_prompt_path", "Prompt path is not a file");
  }
  const content = await readFile(promptPath, "utf8");
  if (content.length > MAX_WORK_PROMPT_CHARACTERS) {
    throw new WorkFileError(
      "prompt_too_large",
      `Prompt file exceeds ${MAX_WORK_PROMPT_CHARACTERS.toLocaleString()} characters`
    );
  }
  return {
    name: promptFileName,
    content,
    size: fileInfo.size,
    modifiedAt: fileInfo.mtime.toISOString(),
  };
}

async function readIndex(directoryPath: string): Promise<WorkIndex> {
  try {
    const raw = JSON.parse(await readFile(getIndexPath(directoryPath), "utf8")) as Partial<WorkIndex>;
    if (raw.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(raw.works)) {
      throw new Error("Unsupported Work Board manifest");
    }
    return { schemaVersion: INDEX_SCHEMA_VERSION, works: raw.works as WorkIndexEntry[] };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return { schemaVersion: INDEX_SCHEMA_VERSION, works: [] };
    throw new WorkFileError(
      "invalid_manifest",
      error instanceof Error ? error.message : "Failed to read Work Board manifest"
    );
  }
}

async function nextPromptFileName(directoryPath: string, index: WorkIndex): Promise<string> {
  const claimed = new Set(index.works.map((work) => work.promptFileName.toLowerCase()));
  for (let sequence = 1; ; sequence++) {
    const candidate = sequence === 1 ? "PROMPT.md" : `PROMPT-${sequence}.md`;
    if (!claimed.has(candidate.toLowerCase()) && !(await exists(path.join(directoryPath, candidate)))) {
      return candidate;
    }
  }
}

async function copySourceDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  const source = resolveWorkDirectory(sourcePath);
  const destination = resolveWorkDirectory(destinationPath);
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) {
    throw new WorkFileError("source_not_found", "Source path is not an accessible directory");
  }
  if (
    canonicalizeWorkPath(source) === canonicalizeWorkPath(destination) ||
    isInside(source, destination) ||
    isInside(destination, source)
  ) {
    throw new WorkFileError("nested_copy", "Source and destination directories cannot contain each other");
  }

  const destinationExists = await exists(destination);
  if (destinationExists) {
    const entries = await readdir(destination);
    if (entries.length > 0) {
      throw new WorkFileError("destination_not_empty", "Copy destination must be empty");
    }
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
  }

  const gitEntry = await stat(path.join(source, ".git")).catch(() => null);
  if (gitEntry?.isFile()) {
    await copyLinkedWorktree(source, destination);
    return;
  }

  if (destinationExists) {
    await copyDirectoryEntries(source, destination, new Set([WORKBOARD_DIRECTORY]));
  } else {
    const sourceBoardPath = path.join(source, WORKBOARD_DIRECTORY);
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      filter: (candidatePath) =>
        candidatePath !== sourceBoardPath && !isInside(sourceBoardPath, candidatePath),
    });
  }
}

async function copyDirectoryEntries(
  source: string,
  destination: string,
  excludedNames: Set<string>
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue;
    await cp(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
  }
}

export async function copyWorkToNumberedSibling(sourcePath: string): Promise<string> {
  const source = resolveWorkDirectory(sourcePath);
  const parentDirectory = path.dirname(source);
  const sourceName = path.basename(source);
  const numberedSource = /^(.*)-(\d+)$/.exec(sourceName);
  const unnumberedSibling = numberedSource
    ? path.join(parentDirectory, numberedSource[1])
    : null;
  const baseName =
    numberedSource && Number(numberedSource[2]) >= 2 && await exists(unnumberedSibling!)
      ? numberedSource[1]
      : sourceName;
  const siblingNames = await readdir(parentDirectory);
  let nextSequence = 2;
  for (const siblingName of siblingNames) {
    if (!siblingName.startsWith(`${baseName}-`)) continue;
    const suffix = siblingName.slice(baseName.length + 1);
    if (!/^\d+$/.test(suffix)) continue;
    nextSequence = Math.max(nextSequence, Number(suffix) + 1);
  }

  for (let sequence = nextSequence; sequence < 10000; sequence++) {
    const destination = path.join(parentDirectory, `${baseName}-${sequence}`);
    try {
      await mkdir(destination);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "EEXIST") continue;
      throw error;
    }

    try {
      await copySourceDirectory(source, destination);
      return destination;
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  throw new WorkFileError("copy_name_exhausted", "Could not allocate a numbered Work directory");
}

export async function provisionWorkDirectory(options: {
  workId: string;
  name: string;
  directoryPath: string;
  prompt: string;
  sourcePath?: string;
}): Promise<WorkDiskRecord> {
  const queueKey = canonicalizeWorkPath(options.directoryPath);
  const previous = provisionQueues.get(queueKey) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => provisionWorkDirectoryUnlocked(options));
  provisionQueues.set(queueKey, operation);
  try {
    return await operation;
  } finally {
    if (provisionQueues.get(queueKey) === operation) provisionQueues.delete(queueKey);
  }
}

async function provisionWorkDirectoryUnlocked(options: {
  workId: string;
  name: string;
  directoryPath: string;
  prompt: string;
  sourcePath?: string;
}): Promise<WorkDiskRecord> {
  const directoryPath = resolveWorkDirectory(options.directoryPath);
  if (options.sourcePath) {
    await copySourceDirectory(options.sourcePath, directoryPath);
  } else {
    await mkdir(directoryPath, { recursive: true });
  }

  const directoryInfo = await stat(directoryPath);
  if (!directoryInfo.isDirectory()) {
    throw new WorkFileError("invalid_path", "Work path is not a directory");
  }

  const index = await readIndex(directoryPath);
  const promptFileName = await nextPromptFileName(directoryPath, index);
  const promptHash = hashWorkContent(options.prompt);
  const now = new Date().toISOString();
  const record: WorkDiskRecord = {
    id: options.workId,
    name: options.name,
    directoryPath,
    canonicalPath: canonicalizeWorkPath(directoryPath),
    promptFileName,
    promptHash,
    createdAt: now,
    updatedAt: now,
  };

  await writeAtomic(getPromptPath(directoryPath, promptFileName), options.prompt);
  await writeAtomic(getWorkManifestPath(directoryPath, options.workId), `${JSON.stringify(record, null, 2)}\n`);
  index.works.push({
    id: options.workId,
    name: options.name,
    promptFileName,
    createdAt: now,
    updatedAt: now,
  });
  await writeAtomic(getIndexPath(directoryPath), `${JSON.stringify(index, null, 2)}\n`);

  return record;
}

export async function unregisterWorkDirectory(record: {
  id: string;
  directoryPath: string;
  promptFileName?: string;
}): Promise<void> {
  const directoryPath = resolveWorkDirectory(record.directoryPath);
  await rm(getWorkManifestPath(directoryPath, record.id), { force: true }).catch(() => {});
  if (record.promptFileName) {
    await rm(getPromptPath(directoryPath, record.promptFileName), { force: true }).catch(() => {});
  }
  const index = await readIndex(directoryPath).catch(() => null);
  if (!index) return;
  index.works = index.works.filter((work) => work.id !== record.id);
  await writeAtomic(getIndexPath(directoryPath), `${JSON.stringify(index, null, 2)}\n`).catch(() => {});
}

export async function updateWorkManifestMetadata(
  work: { id: string; directoryPath: string },
  updates: { name?: string; status?: string }
): Promise<void> {
  const directoryPath = resolveWorkDirectory(work.directoryPath);
  const manifestPath = getWorkManifestPath(directoryPath, work.id);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WorkDiskRecord & {
    status?: string;
  };
  if (updates.name) manifest.name = updates.name;
  if (updates.status) manifest.status = updates.status;
  manifest.updatedAt = new Date().toISOString();
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const index = await readIndex(directoryPath);
  const entry = index.works.find((candidate) => candidate.id === work.id);
  if (entry) {
    if (updates.name) entry.name = updates.name;
    entry.updatedAt = manifest.updatedAt;
    await writeAtomic(getIndexPath(directoryPath), `${JSON.stringify(index, null, 2)}\n`);
  }
}

export async function readWorkPrompt(work: {
  directoryPath: string;
  promptFileName: string;
}): Promise<WorkPromptState> {
  const promptPath = getPromptPath(resolveWorkDirectory(work.directoryPath), work.promptFileName);
  const [content, fileInfo] = await Promise.all([readFile(promptPath, "utf8"), stat(promptPath)]);
  return {
    content,
    hash: hashWorkContent(content),
    modifiedAt: fileInfo.mtime.toISOString(),
  };
}

export async function writeWorkPrompt(
  work: { id: string; directoryPath: string; promptFileName: string },
  content: string,
  expectedHash: string,
  afterWrite?: (prompt: WorkPromptState) => Promise<void>
): Promise<WorkPromptState> {
  const directoryPath = resolveWorkDirectory(work.directoryPath);
  const promptPath = getPromptPath(directoryPath, work.promptFileName);
  const previous = promptWriteQueues.get(promptPath) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const currentContent = await readFile(promptPath, "utf8").catch(() => "");
    const currentHash = hashWorkContent(currentContent);
    if (expectedHash !== currentHash) {
      throw new WorkPromptConflictError(currentContent, currentHash);
    }

    await writeAtomic(promptPath, content);
    const modifiedAt = (await stat(promptPath)).mtime.toISOString();
    const contentHash = hashWorkContent(content);
    const manifestPath = getWorkManifestPath(directoryPath, work.id);
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WorkDiskRecord;
      manifest.promptHash = contentHash;
      manifest.updatedAt = new Date().toISOString();
      await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch {
      // The prompt remains the source of truth even if an optional manifest repair is needed.
    }
    const prompt = { content, hash: contentHash, modifiedAt };
    await afterWrite?.(prompt);
    return prompt;
  });
  promptWriteQueues.set(promptPath, operation);
  try {
    return await operation;
  } finally {
    if (promptWriteQueues.get(promptPath) === operation) promptWriteQueues.delete(promptPath);
  }
}

export async function appendWorkFollowUp(
  work: { id: string; directoryPath: string; promptFileName: string },
  prompt: string,
  options: AppendWorkFollowUpOptions = {}
): Promise<WorkPromptState> {
  const directoryPath = resolveWorkDirectory(work.directoryPath);
  const promptPath = getPromptPath(directoryPath, work.promptFileName);
  const previous = promptWriteQueues.get(promptPath) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const currentContent = await readFile(promptPath, "utf8").catch(() => "");
    const createdAt = options.createdAt ?? new Date();
    const marker = options.followUpId
      ? `<!-- workboard-follow-up:${options.followUpId} -->`
      : null;
    let content = currentContent;
    if (!marker || !currentContent.includes(marker)) {
      const separator = currentContent.trimEnd() ? "\n\n---\n\n" : "";
      const markerLine = marker ? `${marker}\n` : "";
      content = `${currentContent.trimEnd()}${separator}${markerLine}## Follow Up - ${createdAt.toISOString()}\n\n${prompt.trim()}\n`;
      await writeAtomic(promptPath, content);
    }
    const modifiedAt = (await stat(promptPath)).mtime.toISOString();
    const contentHash = hashWorkContent(content);
    const manifestPath = getWorkManifestPath(directoryPath, work.id);
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WorkDiskRecord;
      manifest.promptHash = contentHash;
      manifest.updatedAt = createdAt.toISOString();
      await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch {
      // PROMPT.md remains the source of truth if optional metadata needs repair.
    }
    const updatedPrompt = { content, hash: contentHash, modifiedAt };
    await options.afterWrite?.(updatedPrompt);
    return updatedPrompt;
  });
  promptWriteQueues.set(promptPath, operation);
  try {
    return await operation;
  } finally {
    if (promptWriteQueues.get(promptPath) === operation) promptWriteQueues.delete(promptPath);
  }
}

export async function copyWorkToExperimentBase(
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const source = resolveWorkDirectory(sourcePath);
  const destination = resolveWorkDirectory(destinationPath);
  const sourceBoardPath = path.join(source, WORKBOARD_DIRECTORY);
  if (!isInside(sourceBoardPath, destination) && canonicalizeWorkPath(sourceBoardPath) !== canonicalizeWorkPath(destination)) {
    throw new WorkFileError("invalid_variant_path", "Experiment snapshots must live under .workboard");
  }
  if (await exists(destination)) {
    throw new WorkFileError("destination_exists", "Experiment snapshot already exists");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const gitEntry = await stat(path.join(source, ".git")).catch(() => null);
  if (gitEntry?.isFile()) {
    await copyLinkedWorktree(source, destination);
    return;
  }
  await copyDirectoryEntries(source, destination, new Set([WORKBOARD_DIRECTORY]));
}

export async function copyExperimentVariant(
  basePath: string,
  destinationPath: string
): Promise<void> {
  await copySourceDirectory(basePath, destinationPath);
}