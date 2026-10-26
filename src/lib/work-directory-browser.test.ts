import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listWorkDirectory, previewWorkFile } from "./work-directory-browser";

let fixture: string;
let root: string;
beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), "workboard-files-"));
  root = path.join(fixture, "work");
  await mkdir(root);
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("Work directory listing", () => {
  it("lists folders first, includes files, and lazily resolves nested directories", async () => {
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "answer.md"), "# Answer");
    await writeFile(path.join(root, "docs", "nested.txt"), "Nested answer");
    const listing = await listWorkDirectory(root, "");
    expect(listing.entries).toEqual([
      { name: "docs", path: "docs", kind: "directory" },
      { name: "answer.md", path: "answer.md", kind: "file" },
    ]);
    expect((await listWorkDirectory(root, "docs")).entries).toEqual([
      { name: "nested.txt", path: "docs/nested.txt", kind: "file" },
    ]);
  });

  it("paginates a large folder without silently omitting files", async () => {
    await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(path.join(root, `file-${index}.txt`), "")));
    const first = await listWorkDirectory(root, "");
    const second = await listWorkDirectory(root, "", first.nextOffset!);
    expect(first.entries).toHaveLength(200);
    expect(second.entries).toHaveLength(5);
    expect(second.nextOffset).toBeNull();
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.path)).size).toBe(205);
  });

  it.each(["../outside", "/outside", "C:\\outside", "docs\\file", "C:/outside", "docs/../outside", "docs/file:stream", "a\0b"])(
    "rejects unsafe relative input %j",
    async (relative) => {
      await expect(listWorkDirectory(root, relative)).rejects.toMatchObject({ status: 400 });
      await expect(previewWorkFile(root, relative)).rejects.toMatchObject({ status: 400 });
    },
  );

  it("does not expose symbolic links or junction targets", async () => {
    const outside = path.join(fixture, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "private.txt"), "Must not escape the Work root");
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect((await listWorkDirectory(root, "")).entries[0].kind).toBe("unsupported");
    await expect(listWorkDirectory(root, "linked")).rejects.toMatchObject({ status: 403 });
    await expect(previewWorkFile(root, "linked/private.txt")).rejects.toMatchObject({ status: 403 });
  });

  it("reports non-folder listing requests and invalid page numbers", async () => {
    await writeFile(path.join(root, "text.txt"), "Text");
    await expect(listWorkDirectory(root, "text.txt")).rejects.toMatchObject({ status: 400 });
    await expect(listWorkDirectory(root, "", -1)).rejects.toMatchObject({ status: 400 });
  });
});

describe("read-only browser file responses", () => {
  it("opens text in the browser without interpreting it as HTML", async () => {
    await writeFile(path.join(root, "source.ts"), "<script>not executable</script>");
    const response = await previewWorkFile(root, "source.ts");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^inline/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("<script>not executable</script>");
  });

  it("isolates HTML reports with an opaque sandbox and no script/network privileges", async () => {
    const html = "<style>body{color:green}</style><h1>Report</h1><script>fetch('/api/works')</script>";
    await writeFile(path.join(root, "report.html"), html);
    const response = await previewWorkFile(root, "report.html");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("sandbox;");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).not.toContain("allow-scripts");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(html);
  });

  it("preserves bytes and safely encodes filenames for downloads", async () => {
    const name = "sample (1).bin";
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await writeFile(path.join(root, name), bytes);
    const response = await previewWorkFile(root, name);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).toContain("sample%20%281%29.bin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([["image.png", "image/png"], ["report.pdf", "application/pdf"]])("uses the correct browser media type for %s", async (name, mime) => {
    await writeFile(path.join(root, name), "Synthetic file bytes");
    expect((await previewWorkFile(root, name)).headers.get("content-type")).toBe(mime);
  });

  it("serves an empty file without a synthetic message or corrupted bytes", async () => {
    await writeFile(path.join(root, "empty.txt"), "");
    expect(await (await previewWorkFile(root, "empty.txt")).text()).toBe("");
  });

  it("rejects oversized previews explicitly before loading the file into memory", async () => {
    const file = await open(path.join(root, "large.log"), "w");
    await file.truncate(16 * 1024 * 1024 + 1);
    await file.close();
    await expect(previewWorkFile(root, "large.log")).rejects.toMatchObject({ status: 413 });
  });
});
