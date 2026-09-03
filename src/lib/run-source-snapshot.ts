import { copyFile, link, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  captureDirectorySnapshot,
  createDirectorySnapshotDiff,
  getDirectorySnapshotPath,
  readDirectorySnapshot,
  writeDirectorySnapshot,
} from "@/lib/directory-snapshot";
import { captureWorktreeTree, getWorktreeSnapshotDiff } from "@/lib/git-safety";

export async function captureRunSourceBaseline(
  executionPath: string,
  workDirectory: string,
  runId: string
): Promise<string | null> {
  const gitTree = await captureWorktreeTree(executionPath);
  if (gitTree) return gitTree;
  const snapshotPath = getDirectorySnapshotPath(workDirectory, runId);
  await writeDirectorySnapshot(snapshotPath, await captureDirectorySnapshot(executionPath));
  return null;
}

export async function captureRunSourceDiff(options: {
  executionPath: string;
  workDirectory: string;
  runId: string;
  beforeGitTree: string | null;
}): Promise<{ afterGitTree: string | null; diff: string }> {
  if (options.beforeGitTree) {
    const afterGitTree = await captureWorktreeTree(options.executionPath);
    return {
      afterGitTree,
      diff: await getWorktreeSnapshotDiff(
        options.executionPath,
        options.beforeGitTree,
        afterGitTree
      ),
    };
  }

  const snapshotPath = getDirectorySnapshotPath(options.workDirectory, options.runId);
  const before = await readDirectorySnapshot(snapshotPath).catch(() => null);
  const after = await captureDirectorySnapshot(options.executionPath, before ?? undefined);
  await writeDirectorySnapshot(snapshotPath, after);
  return {
    afterGitTree: null,
    diff: before ? createDirectorySnapshotDiff(before, after) : "",
  };
}

export async function inheritRunSourceBaseline(options: {
  sourceWorkDirectory: string;
  sourceRunId: string;
  sourceGitTree: string | null;
  targetWorkDirectory: string;
  targetRunId: string;
}): Promise<string | null> {
  if (options.sourceGitTree) return options.sourceGitTree;

  const sourcePath = getDirectorySnapshotPath(
    options.sourceWorkDirectory,
    options.sourceRunId
  );
  const sourceInfo = await stat(sourcePath).catch(() => null);
  if (!sourceInfo?.isFile()) {
    throw new Error("Terminal Resume baseline is not ready for this Run");
  }

  const targetPath = getDirectorySnapshotPath(
    options.targetWorkDirectory,
    options.targetRunId
  );
  await mkdir(path.dirname(targetPath), { recursive: true });
  await rm(targetPath, { force: true });
  try {
    await link(sourcePath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) throw error;
    await copyFile(sourcePath, targetPath);
  }
  return null;
}

export async function isRunSourceBaselineReady(options: {
  workDirectory: string;
  runId: string;
  gitTree: string | null;
}): Promise<boolean> {
  if (options.gitTree) return true;
  const snapshotPath = getDirectorySnapshotPath(options.workDirectory, options.runId);
  return stat(snapshotPath).then((info) => info.isFile()).catch(() => false);
}