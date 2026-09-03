import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWorkFollowUp,
  copyWorkToExperimentBase,
  copyWorkToNumberedSibling,
  listDirectoryPromptFiles,
  provisionWorkDirectory,
  readDirectoryPromptFile,
  readWorkPrompt,
  WorkPromptConflictError,
  writeWorkPrompt,
} from "./work-files";

const cleanupPaths: string[] = [];
const executeFile = promisify(execFile);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "work-board-test-"));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("Work directory contract", () => {
  it("lists and reads extensionless and numbered top-level Prompt files safely", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "Prompt"), "extensionless", "utf8");
    await writeFile(path.join(directory, "PROMPT-10.md"), "tenth", "utf8");
    await writeFile(path.join(directory, "PROMPT.md"), "primary", "utf8");
    await writeFile(path.join(directory, "PROMPT-2.md"), "second", "utf8");
    await writeFile(path.join(directory, "notes.md"), "ignore", "utf8");
    await writeFile(path.join(directory, "PROMPT.txt"), "ignore", "utf8");
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "nested", "PROMPT.md"), "nested", "utf8");

    const files = await listDirectoryPromptFiles(directory);

    expect(files.map((file) => file.name)).toEqual([
      "Prompt",
      "PROMPT.md",
      "PROMPT-2.md",
      "PROMPT-10.md",
    ]);
    await expect(readDirectoryPromptFile(directory, "Prompt")).resolves.toMatchObject({
      name: "Prompt",
      content: "extensionless",
    });
    await expect(readDirectoryPromptFile(directory, "PROMPT-2.md")).resolves.toMatchObject({
      name: "PROMPT-2.md",
      content: "second",
    });
    await expect(readDirectoryPromptFile(directory, "../PROMPT.md")).rejects.toMatchObject({
      code: "invalid_prompt_path",
    });
    await expect(readDirectoryPromptFile(directory, "PROMPT.txt")).rejects.toMatchObject({
      code: "invalid_prompt_path",
    });
  });

  it("creates numbered prompt files without overwriting existing content", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "PROMPT.md"), "existing", "utf8");

    const first = await provisionWorkDirectory({
      workId: "work-1",
      name: "First",
      directoryPath: directory,
      prompt: "first prompt",
    });
    const second = await provisionWorkDirectory({
      workId: "work-2",
      name: "Second",
      directoryPath: directory,
      prompt: "second prompt",
    });

    expect(first.promptFileName).toBe("PROMPT-2.md");
    expect(second.promptFileName).toBe("PROMPT-3.md");
    expect(await readFile(path.join(directory, "PROMPT.md"), "utf8")).toBe("existing");
    const index = JSON.parse(
      await readFile(path.join(directory, ".workboard", "index.json"), "utf8")
    ) as { works: Array<{ id: string }> };
    expect(index.works.map((work) => work.id)).toEqual(["work-1", "work-2"]);
  });

  it("detects an external prompt edit before autosave overwrites it", async () => {
    const directory = await temporaryDirectory();
    const record = await provisionWorkDirectory({
      workId: "work-1",
      name: "Conflict",
      directoryPath: directory,
      prompt: "initial",
    });
    const original = await readWorkPrompt(record);
    await writeFile(path.join(directory, record.promptFileName), "external edit", "utf8");

    await expect(writeWorkPrompt(record, "browser edit", original.hash)).rejects.toBeInstanceOf(
      WorkPromptConflictError
    );
    expect(await readFile(path.join(directory, record.promptFileName), "utf8")).toBe("external edit");
  });

  it("allocates distinct prompt names for concurrent Work creation", async () => {
    const directory = await temporaryDirectory();
    const [first, second] = await Promise.all([
      provisionWorkDirectory({
        workId: "concurrent-1",
        name: "Concurrent one",
        directoryPath: directory,
        prompt: "one",
      }),
      provisionWorkDirectory({
        workId: "concurrent-2",
        name: "Concurrent two",
        directoryPath: directory,
        prompt: "two",
      }),
    ]);

    expect(new Set([first.promptFileName, second.promptFileName])).toEqual(
      new Set(["PROMPT.md", "PROMPT-2.md"])
    );
  });

  it("allows only one concurrent write to consume the same prompt hash", async () => {
    const directory = await temporaryDirectory();
    const record = await provisionWorkDirectory({
      workId: "cas-work",
      name: "CAS",
      directoryPath: directory,
      prompt: "initial",
    });
    const original = await readWorkPrompt(record);
    const results = await Promise.allSettled([
      writeWorkPrompt(record, "first", original.hash),
      writeWorkPrompt(record, "second", original.hash),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("serializes cache synchronization with prompt mutations", async () => {
    const directory = await temporaryDirectory();
    const record = await provisionWorkDirectory({
      workId: "cache-sync-work",
      name: "Cache sync",
      directoryPath: directory,
      prompt: "initial",
    });
    const original = await readWorkPrompt(record);
    const order: string[] = [];
    let cacheHash = original.hash;
    let releaseAutosaveSync!: () => void;
    let markAutosaveSyncStarted!: () => void;
    const autosaveSyncCanFinish = new Promise<void>((resolve) => {
      releaseAutosaveSync = resolve;
    });
    const autosaveSyncStarted = new Promise<void>((resolve) => {
      markAutosaveSyncStarted = resolve;
    });

    const autosave = writeWorkPrompt(record, "browser edit", original.hash, async (prompt) => {
      order.push("autosave:start");
      markAutosaveSyncStarted();
      await autosaveSyncCanFinish;
      cacheHash = prompt.hash;
      order.push("autosave:end");
    });
    await autosaveSyncStarted;
    const followUp = appendWorkFollowUp(
      record,
      "Continue",
      {
        createdAt: new Date("2026-09-02T01:00:00.000Z"),
        afterWrite: async (prompt) => {
          cacheHash = prompt.hash;
          order.push("follow-up");
        },
      }
    );

    releaseAutosaveSync();
    await Promise.all([autosave, followUp]);

    expect(order).toEqual(["autosave:start", "autosave:end", "follow-up"]);
    expect(cacheHash).toBe((await readWorkPrompt(record)).hash);
  });

  it("serializes timestamped Follow Up sections into PROMPT.md", async () => {
    const directory = await temporaryDirectory();
    const record = await provisionWorkDirectory({
      workId: "follow-up-work",
      name: "Follow Up",
      directoryPath: directory,
      prompt: "Original prompt\n",
    });

    await Promise.all([
      appendWorkFollowUp(record, "First follow up", {
        createdAt: new Date("2026-09-02T01:00:00.000Z"),
      }),
      appendWorkFollowUp(record, "Second follow up", {
        createdAt: new Date("2026-09-02T02:00:00.000Z"),
      }),
    ]);

    const content = await readFile(path.join(directory, record.promptFileName), "utf8");
    expect(content).toContain("Original prompt\n\n---\n\n## Follow Up - 2026-09-02T01:00:00.000Z");
    expect(content).toContain("## Follow Up - 2026-09-02T02:00:00.000Z\n\nSecond follow up");
  });

  it("appends a recovered Follow Up Run only once", async () => {
    const directory = await temporaryDirectory();
    const record = await provisionWorkDirectory({
      workId: "recovered-follow-up-work",
      name: "Recovered Follow Up",
      directoryPath: directory,
      prompt: "Original prompt",
    });
    const options = {
      createdAt: new Date("2026-09-02T01:00:00.000Z"),
      followUpId: "run-123",
    };

    await appendWorkFollowUp(record, "Continue", options);
    await appendWorkFollowUp(record, "Continue", options);

    const content = await readFile(path.join(directory, record.promptFileName), "utf8");
    expect(content.match(/workboard-follow-up:run-123/g)).toHaveLength(1);
    expect(content.match(/## Follow Up/g)).toHaveLength(1);
  });

  it("copies all source content except Work Board metadata into a numbered sibling", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    await mkdir(path.join(source, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(source, ".workboard", "outputs"), { recursive: true });
    await writeFile(path.join(source, ".hidden"), "hidden", "utf8");
    await writeFile(path.join(source, "node_modules", "pkg", "index.js"), "module", "utf8");
    await writeFile(path.join(source, ".workboard", "outputs", "old.log"), "old", "utf8");

    const destination = await copyWorkToNumberedSibling(source);

    expect(destination).toBe(path.join(root, "source-2"));
    expect(await readFile(path.join(destination, ".hidden"), "utf8")).toBe("hidden");
    expect(await readFile(path.join(destination, "node_modules", "pkg", "index.js"), "utf8")).toBe(
      "module"
    );
    await expect(readFile(path.join(destination, ".workboard", "outputs", "old.log"))).rejects.toThrow();
  });

  it("increments beyond the highest sibling suffix and continues a numbered copy family", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "data.txt"), "source", "utf8");
    await mkdir(path.join(root, "source-2"));
    await mkdir(path.join(root, "source-4"));

    const fifth = await copyWorkToNumberedSibling(source);
    const sixth = await copyWorkToNumberedSibling(fifth);

    expect(fifth).toBe(path.join(root, "source-5"));
    expect(sixth).toBe(path.join(root, "source-6"));
    expect(await readFile(path.join(sixth, "data.txt"), "utf8")).toBe("source");
  });

  it("freezes an experiment base under .workboard without recursively copying metadata", async () => {
    const source = await temporaryDirectory();
    await writeFile(path.join(source, "resource.txt"), "resource", "utf8");
    await mkdir(path.join(source, ".workboard"), { recursive: true });
    await writeFile(path.join(source, ".workboard", "index.json"), "{}", "utf8");
    const base = path.join(source, ".workboard", "variants", "work", "experiment", "base");

    await copyWorkToExperimentBase(source, base);

    expect(await readFile(path.join(base, "resource.txt"), "utf8")).toBe("resource");
    await expect(readFile(path.join(base, ".workboard", "index.json"))).rejects.toThrow();
  });

  it("turns a linked worktree pointer into independent Git metadata when copying", async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, "repository");
    const linked = path.join(root, "linked");
    await mkdir(repository);
    await executeFile("git", ["init"], { cwd: repository });
    await executeFile("git", ["config", "user.email", "workboard@example.test"], { cwd: repository });
    await executeFile("git", ["config", "user.name", "Work Board"], { cwd: repository });
    await writeFile(path.join(repository, "tracked.txt"), "initial\n", "utf8");
    await executeFile("git", ["add", "."], { cwd: repository });
    await executeFile("git", ["commit", "-m", "initial"], { cwd: repository });
    await executeFile("git", ["worktree", "add", linked, "-b", "linked"], { cwd: repository });
    await writeFile(path.join(linked, "tracked.txt"), "modified\n", "utf8");
    await writeFile(path.join(linked, "untracked.txt"), "new\n", "utf8");

    const copy = await copyWorkToNumberedSibling(linked);
    const copyGit = await import("node:fs/promises").then(({ stat }) => stat(path.join(copy, ".git")));
    const { stdout: status } = await executeFile("git", ["status", "--short"], { cwd: copy });
    const { stdout: copyCommon } = await executeFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: copy }
    );
    const { stdout: sourceCommon } = await executeFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: linked }
    );

    expect(copyGit.isDirectory()).toBe(true);
    expect(status).toContain("tracked.txt");
    expect(status).toContain("untracked.txt");
    expect(path.resolve(copyCommon.trim()).toLowerCase()).not.toBe(
      path.resolve(sourceCommon.trim()).toLowerCase()
    );
  });
});