import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveRepoWorkdir } from "@/lib/repo-workdir";
import type { Repo } from "@/generated/prisma/client";

function runGit(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/** Creates and checks out a fresh branch off the given base ref (the repo's default branch) so a run never edits it directly. */
export async function createSafeBranch(repoPath: string, runId: string, baseRef: string): Promise<string> {
  const branchName = `codeboard/run-${runId}`;
  const result = await runGit(["checkout", "-b", branchName, baseRef], repoPath);
  if (result.code !== 0) {
    throw new Error(`Failed to create branch ${branchName}: ${result.stderr}`);
  }
  return branchName;
}

/** Commit SHA that `ref` currently points to in the given working tree, or null if it can't be resolved. */
export async function getHeadCommit(repoPath: string, ref = "HEAD"): Promise<string | null> {
  const result = await runGit(["rev-parse", ref], repoPath);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Returns a unified diff between two refs/commits. A plain two-ref diff only reads committed
 * history and never touches the working tree or index, so it's safe to run even while another
 * run is concurrently checked out to something else in the same shared workdir.
 */
export async function getBranchDiff(repoPath: string, fromRef: string, toRef: string): Promise<string> {
  const result = await runGit(["diff", fromRef, toRef], repoPath);
  return result.stdout;
}

/** Captures committed, staged, unstaged, and untracked changes relative to a base commit. */
export async function getWorktreeDiff(repoPath: string, baseRef: string | null): Promise<string> {
  if (!(await isGitRepo(repoPath))) return "";
  const tracked = await runGit(["diff", "--binary", baseRef ?? "HEAD"], repoPath);
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], repoPath);
  const sections = [tracked.stdout];

  for (const relativePath of untracked.stdout.split("\0").filter(Boolean)) {
    const patch = await runGit(["diff", "--no-index", "--binary", "--", "/dev/null", relativePath], repoPath);
    if (patch.stdout) sections.push(patch.stdout);
  }

  return sections.filter(Boolean).join("\n");
}

/** Writes the current non-ignored working tree to an isolated Git tree without changing the real index. */
export async function captureWorktreeTree(repoPath: string): Promise<string | null> {
  if (!(await isGitRepo(repoPath))) return null;
  const temporaryDirectory = path.join(repoPath, ".workboard", "tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  const temporaryIndex = path.join(temporaryDirectory, `git-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };

  try {
    const empty = await runGit(["read-tree", "--empty"], repoPath, env);
    if (empty.code !== 0) throw new Error(empty.stderr || "Failed to initialize Git snapshot");
    const add = await runGit(
      ["add", "-A", "--", ".", ":(exclude).workboard", ":(exclude).workboard/**"],
      repoPath,
      env
    );
    if (add.code !== 0) throw new Error(add.stderr || "Failed to capture Git snapshot");
    const tree = await runGit(["write-tree"], repoPath, env);
    if (tree.code !== 0) throw new Error(tree.stderr || "Failed to write Git snapshot");
    return tree.stdout.trim() || null;
  } finally {
    await rm(temporaryIndex, { force: true }).catch(() => {});
  }
}

export async function getWorktreeSnapshotDiff(
  repoPath: string,
  beforeTree: string | null,
  afterTree: string | null
): Promise<string> {
  if (!beforeTree || !afterTree) return "";
  const result = await runGit(["diff", "--binary", beforeTree, afterTree], repoPath);
  if (result.code !== 0) throw new Error(result.stderr || "Failed to compare Git snapshots");
  return result.stdout;
}

/** Computes the immutable committed diff captured for a run without checking out either ref. */
export async function getRunDiff(run: {
  baseCommit: string | null;
  finalCommit: string | null;
  executionPath?: string | null;
  task?: { repo: Repo } | null;
}): Promise<string> {
  if (!run.baseCommit || !run.finalCommit) return "";
  try {
    const repoPath = run.executionPath ?? (run.task ? await resolveRepoWorkdir(run.task.repo) : null);
    if (!repoPath) return "";
    return await getBranchDiff(repoPath, run.baseCommit, run.finalCommit);
  } catch {
    return "";
  }
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return result.stdout.trim();
}

/** The `origin` remote URL configured in the repo's workdir, or null if there isn't one (e.g. not cloned yet, or a local repo with no remote). */
export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const result = await runGit(["config", "--get", "remote.origin.url"], repoPath);
    const url = result.stdout.trim();
    return result.code === 0 && url ? url : null;
  } catch {
    return null;
  }
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], repoPath);
  return result.code === 0;
}
