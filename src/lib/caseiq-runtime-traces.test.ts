import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPrivateRuntimeAsset, protectRuntimeTraces } from "../../scripts/protect-runtime-traces.mjs";
import { resolveNextDistDir } from "../../scripts/next-output.mjs";

let root: string;
let trace: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workboard-caseiq-trace-"));
  trace = path.join(root, ".next", "server", "instrumentation.js.nft.json");
  await mkdir(path.dirname(trace), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CaseIQ runtime trace protection", () => {
  it("keeps the default output and rejects source/private/outside directories", () => {
    expect(resolveNextDistDir("")).toBe(".next");
    expect(resolveNextDistDir(".next-test-3309")).toBe(".next-test-3309");
    for (const directory of ["..", ".", "src", "data", "node_modules", "..\\build", "C:\\build", ".next-test\\private"]) {
      expect(() => resolveNextDistDir(directory)).toThrow("generated");
    }
  });

  it("protects an isolated test output without touching the running default build", async () => {
    const original = JSON.stringify({ version: 1, files: [path.relative(path.dirname(trace), path.join(root, "data", "normal-private.json"))] });
    await writeFile(trace, original);
    const testTrace = path.join(root, ".next-test-3309", "server", "instrumentation.js.nft.json");
    await mkdir(path.dirname(testTrace), { recursive: true });
    await writeFile(testTrace, JSON.stringify({ version: 1, files: [path.relative(path.dirname(testTrace), path.join(root, "data", "test-private.json"))] }));
    await expect(protectRuntimeTraces(root, { WORKBOARD_NEXT_DIST_DIR: ".next-test-3309" })).resolves.toMatchObject({
      traces: 1, removedPrivateReferences: 1,
    });
    expect(await readFile(trace, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(testTrace, "utf8")).files).toEqual([]);
    await expect(protectRuntimeTraces(root, {
      WORKBOARD_NEXT_DIST_DIR: ".next-test-3309",
      WORKBOARD_CASEIQ_STATE_ROOT: path.join(root, ".next-test-3309", "private"),
    })).rejects.toThrow("build output");
  });

  it("recognizes private host assets without matching similarly named public folders", () => {
    for (const file of ["data\\caseiq\\installation.json", ".workboard\\outputs\\result.md", ".env.local", "dev.db-wal"]) {
      expect(isPrivateRuntimeAsset(root, path.join(root, ...file.split("\\")))).toBe(true);
    }
    expect(isPrivateRuntimeAsset(root, path.join(root, "database", "schema.ts"))).toBe(false);
    expect(isPrivateRuntimeAsset(root, path.join(root, "docs", "caseiq-integration.md"))).toBe(false);
  });

  it("removes private references from instrumentation while preserving code and original host data", async () => {
    const privateFile = path.join(root, "data", "caseiq", "installation.json");
    await mkdir(path.dirname(privateFile), { recursive: true });
    await writeFile(privateFile, "synthetic host-private content");
    const publicFiles = [
      path.join(root, "scripts", "workboard-caseiq.ps1"),
      path.join(root, "node_modules", "zod", "index.js"),
      path.join(root, "docs", "caseiq-integration.md"),
    ];
    await writeFile(trace, JSON.stringify({
      version: 1, files: [...publicFiles, privateFile, path.join(root, "dev.db")].map((file) => path.relative(path.dirname(trace), file)),
    }));
    await expect(protectRuntimeTraces(root)).resolves.toEqual({ traces: 1, removedPrivateReferences: 2, copiedPrivateAssets: 0 });
    const result = JSON.parse(await readFile(trace, "utf8"));
    expect(result.files).toEqual(publicFiles.map((file) => path.relative(path.dirname(trace), file)));
    expect(await readFile(privateFile, "utf8")).toBe("synthetic host-private content");
    await expect(protectRuntimeTraces(root)).resolves.toMatchObject({ removedPrivateReferences: 0 });
  });

  it("fails closed if standalone has already copied host-private data", async () => {
    const copied = path.join(root, ".next", "standalone", "data", "private.json");
    await mkdir(path.dirname(copied), { recursive: true });
    await writeFile(copied, "synthetic");
    const original = JSON.stringify({ version: 1, files: [] });
    await writeFile(trace, original);
    await expect(protectRuntimeTraces(root)).rejects.toThrow("Do not deploy");
    expect(await readFile(trace, "utf8")).toBe(original);
    expect(await readFile(copied, "utf8")).toBe("synthetic");
  });

  it("rejects malformed or missing traces instead of reporting a clean deployment", async () => {
    await expect(protectRuntimeTraces(root)).rejects.toThrow("No deployment traces");
    await writeFile(trace, JSON.stringify({ version: 1, files: [123] }));
    await expect(protectRuntimeTraces(root)).rejects.toThrow("Invalid deployment trace");
  });

  it("rejects unsafe runtime-root configuration rather than filtering application assets", async () => {
    await writeFile(trace, JSON.stringify({ version: 1, files: [] }));
    await expect(protectRuntimeTraces(root, { WORKBOARD_CASEIQ_STATE_ROOT: root })).rejects.toThrow("must not contain");
    await expect(protectRuntimeTraces(root, { WORKBOARD_CASEIQ_STATE_ROOT: path.join(root, ".next", "private") })).rejects.toThrow("build output");
  });
});
