import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExplorerDirectory } from "./local-explorer";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))
  );
});

describe("local Explorer directory validation", () => {
  it("resolves an existing directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workboard explorer "));
    cleanupPaths.push(directory);
    await expect(resolveExplorerDirectory(directory)).resolves.toBe(path.resolve(directory));
  });

  it("rejects files and missing paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workboard-explorer-"));
    cleanupPaths.push(directory);
    const file = path.join(directory, "file.txt");
    await writeFile(file, "not a directory", "utf8");

    await expect(resolveExplorerDirectory(file)).rejects.toThrow("Directory does not exist");
    await expect(resolveExplorerDirectory(path.join(directory, "missing"))).rejects.toThrow(
      "Directory does not exist"
    );
  });
});
