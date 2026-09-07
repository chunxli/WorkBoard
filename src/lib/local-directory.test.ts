import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildDirectory, validateFolderName } from "./local-directory";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))
  );
});

describe("local directory creation", () => {
  it("creates one direct child without creating a nested path", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workboard-create-folder-"));
    cleanupPaths.push(parent);

    const created = await createChildDirectory(parent, "New Work");

    expect(created).toBe(path.join(parent, "New Work"));
    await expect(stat(created)).resolves.toMatchObject({});
    expect((await stat(created)).isDirectory()).toBe(true);
  });

  it("rejects traversal, separators, reserved names, and invalid suffixes", () => {
    for (const name of [".", "..", "nested/child", "nested\\child", "CON", "aux.txt", "name."]) {
      expect(() => validateFolderName(name)).toThrow();
    }
    expect(validateFolderName("  valid name  ")).toBe("valid name");
  });

  it("requires an existing directory as the parent", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workboard-create-folder-"));
    cleanupPaths.push(parent);
    const file = path.join(parent, "file.txt");
    await writeFile(file, "not a directory", "utf8");

    await expect(createChildDirectory(file, "child")).rejects.toThrow(
      "Parent directory does not exist"
    );
    await expect(createChildDirectory(path.join(parent, "missing"), "child")).rejects.toThrow(
      "Parent directory does not exist"
    );
  });

  it("does not reuse or overwrite an existing folder", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "workboard-create-folder-"));
    cleanupPaths.push(parent);
    await createChildDirectory(parent, "existing");

    await expect(createChildDirectory(parent, "existing")).rejects.toThrow(
      "A folder with this name already exists"
    );
  });
});