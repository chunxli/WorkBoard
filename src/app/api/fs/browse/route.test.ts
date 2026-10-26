import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readdir: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), readdir: mocks.readdir,
}));
import { GET } from "./route";

describe("optional immediate file metadata for the directory browser", () => {
  let root: string;
  let directory: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    mocks.readdir.mockImplementation(original.readdir);
    root = await mkdtemp(path.join(tmpdir(), "workboard-prompt-list-"));
    directory = path.join(root, "listed");
    await mkdir(path.join(directory, "folder"), { recursive: true });
    await writeFile(path.join(directory, "folder", "not-a-top-level-file.txt"), "synthetic nested content");
    await writeFile(path.join(directory, "file with spaces.txt"), "synthetic content");
    await writeFile(path.join(directory, ".hidden.txt"), "synthetic hidden file");
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function list(includeFiles?: string, selected = directory) {
    const query = new URLSearchParams({ path: selected, ...(includeFiles !== undefined ? { includeFiles } : {}) });
    return GET(new NextRequest(`http://localhost/api/fs/browse?${query}`));
  }

  it("preserves the default folder-only response", async () => {
    const response = await list();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["current", "entries", "parent", "roots"]);
    expect(body.entries).toEqual([{ name: "folder", path: path.join(directory, "folder") }]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns every immediate name, including dotfiles, without reading contents or subdirectories", async () => {
    const body = await (await list("1")).json();
    expect(body.items).toEqual([
      { name: "folder", path: path.join(directory, "folder"), kind: "directory" },
      { name: ".hidden.txt", path: path.join(directory, ".hidden.txt"), kind: "file" },
      { name: "file with spaces.txt", path: path.join(directory, "file with spaces.txt"), kind: "file" },
    ]);
    expect(body.entries).toEqual([{ name: "folder", path: path.join(directory, "folder") }]);
    expect(mocks.readdir).toHaveBeenCalledExactlyOnceWith(directory, { withFileTypes: true });
    expect(await readFile(path.join(directory, "file with spaces.txt"), "utf8")).toBe("synthetic content");
  });

  it("does not cap the number of top-level names", async () => {
    await Promise.all(Array.from({ length: 250 }, (_, index) => writeFile(path.join(directory, `item-${String(index).padStart(3, "0")}.txt`), "")));
    const body = await (await list("1")).json();
    expect(body.items).toHaveLength(253);
    expect(body.items.at(-1).name).toBe("item-249.txt");
  });

  it("lists redirected entries only as text references and never follows them", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "private-child.txt"), "synthetic outside content");
    await symlink(outside, path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
    const body = await (await list("1")).json();
    expect(body.items).toContainEqual({ name: "linked", path: path.join(directory, "linked"), kind: "reference" });
    expect(body.entries.some((entry: { name: string }) => entry.name === "linked")).toBe(false);
    expect(mocks.readdir).toHaveBeenCalledExactlyOnceWith(directory, { withFileTypes: true });
  });

  it("distinguishes empty directories, invalid options and read errors", async () => {
    const empty = path.join(root, "empty");
    await mkdir(empty);
    expect((await (await list("1", empty)).json()).items).toEqual([]);
    expect((await list("true")).status).toBe(400);
    expect((await list("1", path.join(root, "missing"))).status).toBe(400);
    mocks.readdir.mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
    const response = await list("1");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Permission denied", current: directory });
    expect(await readdir(empty)).toEqual([]);
  });
});
