import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const globalForRunArtifacts = globalThis as unknown as {
  runFinalizationQueues?: Map<string, Promise<unknown>>;
};
const runFinalizationQueues =
  globalForRunArtifacts.runFinalizationQueues ?? new Map<string, Promise<unknown>>();
globalForRunArtifacts.runFinalizationQueues = runFinalizationQueues;

export interface RunArtifactPaths {
  outputDirectory: string;
  result: string;
  transcript: string;
  diff: string;
  snapshot: string;
  stdout: string;
  stderr: string;
}

export interface WorkRunSnapshot {
  schemaVersion: 1;
  runId: string;
  workId: string | null;
  workName: string;
  promptFileName: string | null;
  prompt: string;
  promptHash: string;
  engine: "CLI" | "SDK";
  sessionId: string;
  executionPath: string;
  concurrencyMode: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  gitBeforeTree: string | null;
  gitAfterTree: string | null;
  experimentVariantId?: string | null;
  skillName?: string | null;
  skillHash?: string | null;
  skillInvocationMode?: "EXPLICIT" | "AUTO" | null;
  agent?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  contextTier?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: string | null;
  outputFormat?: string | null;
  timeoutSeconds?: number | null;
  sessionEventCursorStart?: number;
  taskId?: string | null;
  resourceName?: string | null;
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

export function getWorkRunArtifactPaths(workDirectory: string, runId: string): RunArtifactPaths {
  return getRunArtifactPaths(path.join(workDirectory, ".workboard", "outputs", runId));
}

export function getAutomationRunArtifactPaths(runId: string): RunArtifactPaths {
  return getRunArtifactPaths(
    path.join(/* turbopackIgnore: true */ process.cwd(), "data", "run-artifacts", runId)
  );
}

function getRunArtifactPaths(outputDirectory: string): RunArtifactPaths {
  return {
    outputDirectory,
    result: path.join(outputDirectory, "result.md"),
    transcript: path.join(outputDirectory, "transcript.jsonl"),
    diff: path.join(outputDirectory, "diff.patch"),
    snapshot: path.join(outputDirectory, "run.json"),
    stdout: path.join(outputDirectory, "stdout.log"),
    stderr: path.join(outputDirectory, "stderr.log"),
  };
}

export async function prepareWorkRunArtifacts(
  workDirectory: string,
  runId: string,
  snapshot: WorkRunSnapshot
): Promise<RunArtifactPaths> {
  const paths = getWorkRunArtifactPaths(workDirectory, runId);
  await prepareRunArtifacts(paths, snapshot);
  return paths;
}

export async function prepareRunArtifacts(
  paths: RunArtifactPaths,
  snapshot: WorkRunSnapshot
): Promise<void> {
  await mkdir(paths.outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(paths.stdout, "", "utf8"),
    writeFile(paths.stderr, "", "utf8"),
    writeFile(paths.transcript, "", "utf8"),
    writeFile(paths.diff, "", "utf8"),
    writeAtomic(paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`),
  ]);
}

export async function finalizeWorkRunArtifacts(options: {
  paths: RunArtifactPaths;
  snapshot: WorkRunSnapshot;
  finalOutput: string | null;
  diff: string;
}): Promise<void> {
  const { paths, snapshot } = options;
  const result = options.finalOutput?.trim()
    ? `${options.finalOutput.trim()}\n`
    : snapshot.errorMessage
      ? `# Run failed\n\n${snapshot.errorMessage}\n`
      : `# Run finished\n\nNo final assistant response was captured.\n`;

  await Promise.all([
    writeAtomic(paths.result, result),
    writeAtomic(paths.diff, options.diff),
    writeAtomic(paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`),
    copyFile(paths.stdout, paths.transcript).catch(async () => {
      await writeAtomic(paths.transcript, "");
    }),
  ]);
}

export async function describeRunArtifact(filePath: string): Promise<{
  path: string;
  byteSize: number;
  sha256: string;
}> {
  const [content, fileInfo] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    path: filePath,
    byteSize: fileInfo.size,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export async function readWorkRunSnapshot(snapshotPath: string): Promise<WorkRunSnapshot> {
  return JSON.parse(await readFile(snapshotPath, "utf8")) as WorkRunSnapshot;
}

export async function serializeRunFinalization<T>(
  runId: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = runFinalizationQueues.get(runId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(action);
  runFinalizationQueues.set(runId, operation);
  try {
    return await operation;
  } finally {
    if (runFinalizationQueues.get(runId) === operation) runFinalizationQueues.delete(runId);
  }
}