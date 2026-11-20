import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCaseIqPackCatalog } from "./caseiq-installation";

const execute = promisify(execFile);
let root: string;
let commit: string;
const git = async (...args: string[]) => (await execute("git", ["-C", root, "--no-pager", ...args], { windowsHide: true })).stdout.trim();

async function pack(id: string, name = id) {
  const directory = path.join(root, "support-packs", id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "pack.yaml"), `metadata:\n  id: ${id}\n  name: ${JSON.stringify(name)}\n`);
}

async function saveCommit() {
  await git("add", "--", "support-packs");
  await git("-c", "user.name=WorkBoard Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m",
    "Synthetic CaseIQ catalog fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>");
  return git("rev-parse", "HEAD");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-catalog-"));
  await git("init", "--initial-branch=main");
  await pack("approved", "Approved");
  await pack("platform", "Platform");
  commit = await saveCommit();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("CaseIQ committed support-pack catalog", () => {
  it("reads the frozen commit's supported manifests and keeps catalog ordering", async () => {
    await expect(readCaseIqPackCatalog(root, commit)).resolves.toEqual([
      { id: "approved", name: "Approved" }, { id: "platform", name: "Platform" },
    ]);
  });

  it("uses one Git tree command for five simultaneous reads of the same frozen catalog", async () => {
    const trace = path.join(root, "git-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    await Promise.all(Array.from({ length: 5 }, () => readCaseIqPackCatalog(root, commit)));
    await readCaseIqPackCatalog(root, commit);
    const events = (await readFile(trace, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "start" && event.argv.includes("ls-tree"))).toHaveLength(1);
  });

  it("does not keep a failed Git lookup after the repository becomes readable again", async () => {
    const directory = path.join(root, ".git");
    const hidden = path.join(root, "hidden-git");
    await rename(directory, hidden);
    try { await expect(readCaseIqPackCatalog(root, commit)).rejects.toThrow(); }
    finally { await rename(hidden, directory); }
    await expect(readCaseIqPackCatalog(root, commit)).resolves.toHaveLength(2);
  });

  it("does not offer an untracked pack or change its files", async () => {
    await pack("untracked", "Untracked");
    await expect(readCaseIqPackCatalog(root, commit)).resolves.toHaveLength(2);
    expect(await readFile(path.join(root, "support-packs", "untracked", "pack.yaml"), "utf8")).toContain("Untracked");
    expect(await git("status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("uses the supplied commit rather than silently switching the catalog to a later HEAD", async () => {
    await pack("next-pack", "Next pack");
    const next = await saveCommit();
    expect((await readCaseIqPackCatalog(root, commit)).map((item) => item.id)).not.toContain("next-pack");
    expect((await readCaseIqPackCatalog(root, next)).map((item) => item.id)).toContain("next-pack");
  });

  it("keeps only the latest root/commit index instead of retaining an unbounded commit history", async () => {
    await pack("next-pack");
    const next = await saveCommit();
    const trace = path.join(root, "git-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    await readCaseIqPackCatalog(root, commit);
    await readCaseIqPackCatalog(root, next);
    await readCaseIqPackCatalog(root, commit);
    const events = (await readFile(trace, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "start" && event.argv.includes("ls-tree"))).toHaveLength(3);
  });

  it("does not interpret nested manifests or unsupported IDs as top-level packs", async () => {
    await pack("OpsCenter", "Unsupported uppercase ID");
    await pack("approved/nested", "Nested");
    const next = await saveCommit();
    await expect(readCaseIqPackCatalog(root, next)).resolves.toHaveLength(2);
  });

  it("rejects a missing committed manifest instead of returning a partial catalog", async () => {
    await readCaseIqPackCatalog(root, commit);
    await rm(path.join(root, "support-packs", "approved", "pack.yaml"));
    await expect(readCaseIqPackCatalog(root, commit)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects inconsistent metadata rather than aliasing another pack ID", async () => {
    await readCaseIqPackCatalog(root, commit);
    await writeFile(path.join(root, "support-packs", "approved", "pack.yaml"), "metadata:\n  id: different\n");
    await expect(readCaseIqPackCatalog(root, commit)).rejects.toThrow("inconsistent");
  });

  it("rejects a manifest directory instead of treating it as a file", async () => {
    await readCaseIqPackCatalog(root, commit);
    const file = path.join(root, "support-packs", "approved", "pack.yaml");
    await rm(file);
    await mkdir(file);
    await expect(readCaseIqPackCatalog(root, commit)).rejects.toThrow("regular file");
  });

  it.each(["namespace", "pack"])("rejects a %s directory junction or symbolic link", async (kind) => {
    await readCaseIqPackCatalog(root, commit);
    const directory = path.join(root, "support-packs", ...(kind === "pack" ? ["approved"] : []));
    const target = path.join(root, "linked-content");
    await rename(directory, target);
    await symlink(target, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(readCaseIqPackCatalog(root, commit)).rejects.toThrow("regular directories");
  });

  it("refuses an unverified revision expression instead of passing it to Git", async () => {
    await expect(readCaseIqPackCatalog(root, "HEAD")).rejects.toThrow("source revision");
    await expect(readCaseIqPackCatalog(root, "--help")).rejects.toThrow("source revision");
  });
});
