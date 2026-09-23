import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorktreeTree, getWorktreeSnapshotDiff } from "./git-safety";
import {
  finalizeWorkRunArtifacts,
  prepareWorkRunArtifacts,
  readRunDiffPreview,
  readRunLogTail,
  type WorkRunSnapshot,
} from "./run-artifacts";
import {
  captureDirectorySnapshot,
  createDirectorySnapshotDiff,
  readDirectorySnapshot,
  writeDirectorySnapshot,
} from "./directory-snapshot";
import {
  captureRunSourceBaseline,
  captureRunSourceDiff,
  inheritRunSourceBaseline,
  isRunSourceBaselineReady,
} from "./run-source-snapshot";

const executeFile = promisify(execFile);
const cleanupPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "work-board-artifact-"));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("Git Work snapshots", () => {
  it("captures tracked and untracked changes while excluding .workboard output", async () => {
    const repository = await temporaryDirectory();
    await executeFile("git", ["init"], { cwd: repository });
    await executeFile("git", ["config", "user.email", "workboard@example.test"], { cwd: repository });
    await executeFile("git", ["config", "user.name", "Work Board"], { cwd: repository });
    await writeFile(path.join(repository, "tracked.txt"), "before\n", "utf8");
    await executeFile("git", ["add", "tracked.txt"], { cwd: repository });
    await executeFile("git", ["commit", "-m", "initial"], { cwd: repository });
    const before = await captureWorktreeTree(repository);

    await writeFile(path.join(repository, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(repository, "new.txt"), "new\n", "utf8");
    await mkdir(path.join(repository, ".workboard"), { recursive: true });
    await writeFile(path.join(repository, ".workboard", "runtime.log"), "ignore\n", "utf8");
    const after = await captureWorktreeTree(repository);
    const diff = await getWorktreeSnapshotDiff(repository, before, after);

    expect(diff).toContain("tracked.txt");
    expect(diff).toContain("new.txt");
    expect(diff).not.toContain("runtime.log");
  });

  it("does not describe an unknown terminal state as a failed run", async () => {
    const work = await temporaryDirectory();
    const snapshot: WorkRunSnapshot = {
      schemaVersion: 1,
      runId: "unknown-run",
      workId: "work-1",
      workName: "Example",
      promptFileName: "PROMPT.md",
      prompt: "Do the work",
      promptHash: "hash",
      engine: "CLI",
      sessionId: "session-1",
      executionPath: work,
      concurrencyMode: "EXTERNAL_TERMINAL",
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      errorMessage: null,
      gitBeforeTree: null,
      gitAfterTree: null,
    };
    const paths = await prepareWorkRunArtifacts(work, "unknown-run", snapshot);
    await finalizeWorkRunArtifacts({
      paths,
      snapshot: {
        ...snapshot,
        status: "UNKNOWN",
        finishedAt: new Date().toISOString(),
        errorMessage: "Terminal callback expired; the Terminal state is unknown",
      },
      finalOutput: null,
      diff: "",
    });

    const result = await readFile(paths.result, "utf8");
    expect(result).toContain("# Terminal state unknown");
    expect(result).not.toContain("# Run failed");
  });
});

describe("Run artifacts", () => {
  it("rolls a non-Git completion snapshot forward for fast terminal Resume", async () => {
    const work = await temporaryDirectory();
    await writeFile(path.join(work, "report.txt"), "before\n", "utf8");
    await captureRunSourceBaseline(work, work, "parent-run");

    await writeFile(path.join(work, "report.txt"), "completed\n", "utf8");
    const parentDiff = await captureRunSourceDiff({
      executionPath: work,
      workDirectory: work,
      runId: "parent-run",
      beforeGitTree: null,
    });

    expect(parentDiff.diff).toContain("-before");
    expect(parentDiff.diff).toContain("+completed");
    await expect(
      isRunSourceBaselineReady({ workDirectory: work, runId: "parent-run", gitTree: null })
    ).resolves.toBe(true);

    const inheritedTree = await inheritRunSourceBaseline({
      sourceWorkDirectory: work,
      sourceRunId: "parent-run",
      sourceGitTree: null,
      targetWorkDirectory: work,
      targetRunId: "resume-run",
    });
    expect(inheritedTree).toBeNull();

    await writeFile(path.join(work, "report.txt"), "resumed\n", "utf8");
    const resumeDiff = await captureRunSourceDiff({
      executionPath: work,
      workDirectory: work,
      runId: "resume-run",
      beforeGitTree: inheritedTree,
    });
    expect(resumeDiff.diff).toContain("-completed");
    expect(resumeDiff.diff).toContain("+resumed");
  });

  it("always writes the complete portable result set", async () => {
    const work = await temporaryDirectory();
    const snapshot: WorkRunSnapshot = {
      schemaVersion: 1,
      runId: "run-1",
      workId: "work-1",
      workName: "Example",
      promptFileName: "PROMPT.md",
      prompt: "Do the work",
      promptHash: "hash",
      engine: "CLI",
      sessionId: "session-1",
      executionPath: work,
      concurrencyMode: "DIRECT",
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      errorMessage: null,
      gitBeforeTree: null,
      gitAfterTree: null,
    };
    const paths = await prepareWorkRunArtifacts(work, "run-1", snapshot);
    await writeFile(paths.stdout, '{"type":"assistant.message"}\n', "utf8");
    await writeFile(paths.stderr, "warning\n", "utf8");
    await finalizeWorkRunArtifacts({
      paths,
      snapshot: { ...snapshot, status: "SUCCESS", exitCode: 0, finishedAt: new Date().toISOString() },
      finalOutput: "Done",
      diff: "diff --git a/file b/file\n",
    });

    expect((await readdir(paths.outputDirectory)).sort()).toEqual(
      ["diff.patch", "result.md", "run.json", "stderr.log", "stdout.log", "transcript.jsonl"].sort()
    );
    expect(await readFile(paths.result, "utf8")).toBe("Done\n");
    expect(await readFile(paths.transcript, "utf8")).toContain("assistant.message");
  });

  it("returns complete small logs and only complete records from large log tails", async () => {
    const work = await temporaryDirectory();
    const logPath = path.join(work, "stdout.log");
    await writeFile(logPath, "first\nsecond\n", "utf8");
    await expect(readRunLogTail(logPath, 64)).resolves.toBe("first\nsecond\n");

    await writeFile(logPath, `${"x".repeat(128)}\ntail-one\ntail-two\n`, "utf8");
    const tail = await readRunLogTail(logPath, 32);
    expect(tail).toContain("Earlier output omitted");
    expect(tail).toContain("tail-one\ntail-two\n");
    expect(tail).not.toContain("x".repeat(16));
  });

  it("limits large diff previews to complete lines", async () => {
    const work = await temporaryDirectory();
    const diffPath = path.join(work, "diff.patch");
    await writeFile(diffPath, `diff --git a/file b/file\n${"x".repeat(128)}\nsecond\n`, "utf8");

    const preview = await readRunDiffPreview(diffPath, 32);

    expect(preview).toBe(
      "diff --git a/file b/file\n[Diff preview truncated. Download diff.patch for the complete diff.]\n"
    );
  });

  it("generates a patch for changed, added, deleted, and binary files outside Git", async () => {
    const work = await temporaryDirectory();
    await writeFile(path.join(work, "changed.txt"), "before\n", "utf8");
    await writeFile(path.join(work, "deleted.txt"), "delete me\n", "utf8");
    await writeFile(path.join(work, "binary.bin"), Buffer.from([0, 1, 2]));
    const before = await captureDirectorySnapshot(work);

    await writeFile(path.join(work, "changed.txt"), "after\n", "utf8");
    await rm(path.join(work, "deleted.txt"));
    await writeFile(path.join(work, "added.txt"), "new\n", "utf8");
    await writeFile(path.join(work, "binary.bin"), Buffer.from([0, 1, 3]));
    await mkdir(path.join(work, ".workboard"));
    await writeFile(path.join(work, ".workboard", "ignored.log"), "ignore", "utf8");
    const after = await captureDirectorySnapshot(work);
    const diff = createDirectorySnapshotDiff(before, after);

    expect(diff).toContain("changed.txt");
    expect(diff).toContain("added.txt");
    expect(diff).toContain("deleted.txt");
    expect(diff).toContain("Binary or large file changed");
    expect(diff).not.toContain("ignored.log");
  });

  it("excludes dependency, VCS, and generated cache trees outside Git", async () => {
    const work = await temporaryDirectory();
    await writeFile(path.join(work, "source.txt"), "source\n", "utf8");
    for (const directory of [".git", ".next", ".workboard", "node_modules", "coverage"]) {
      await mkdir(path.join(work, "nested", directory), { recursive: true });
      await writeFile(path.join(work, "nested", directory, "large.cache"), "ignore\n", "utf8");
    }

    const snapshot = await captureDirectorySnapshot(work);

    expect(Object.keys(snapshot.entries)).toEqual(["source.txt"]);
  });

  it("reuses unchanged file hashes and rehashes same-size edits", async () => {
    const work = await temporaryDirectory();
    const sourcePath = path.join(work, "source.txt");
    await writeFile(sourcePath, "before\n", "utf8");
    const before = await captureDirectorySnapshot(work);
    before.entries["source.txt"].sha256 = "reused-hash";

    const unchanged = await captureDirectorySnapshot(work, before);
    expect(unchanged.entries["source.txt"].sha256).toBe("reused-hash");

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(sourcePath, "after!\n", "utf8");
    const changed = await captureDirectorySnapshot(work, unchanged);
    expect(changed.entries["source.txt"].sha256).not.toBe("reused-hash");
    expect(createDirectorySnapshotDiff(unchanged, changed)).toContain("source.txt");
  });

  it("incrementally reads legacy snapshots and ignores their generated entries", async () => {
    const work = await temporaryDirectory();
    const snapshotPath = path.join(work, ".workboard", "tmp", "legacy-snapshot.json");
    await writeFile(path.join(work, "source.txt"), "source\n", "utf8");
    const legacy = await captureDirectorySnapshot(work);
    legacy.entries["source.txt"].sha256 = "legacy-reused-hash";
    delete legacy.entries["source.txt"].mtimeMs;
    delete legacy.capturedAtMs;
    legacy.entries["node_modules/package/cache.bin"] = {
      kind: "file",
      size: 5,
      sha256: "ignored-hash",
    };
    await writeDirectorySnapshot(snapshotPath, legacy);

    const loaded = await readDirectorySnapshot(snapshotPath);
    const current = await captureDirectorySnapshot(work, loaded);
    const diff = createDirectorySnapshotDiff(loaded, current);

    expect(current.entries["source.txt"].sha256).toBe("legacy-reused-hash");
    expect(diff).not.toContain("node_modules");
  });
});