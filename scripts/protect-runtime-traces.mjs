import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNextDistDir } from "./next-output.mjs";

/** @param {string} root @param {string} file */
export function isPrivateRuntimeAsset(root, file) {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep).map((part) => process.platform === "win32" ? part.toLowerCase() : part);
  return parts[0] === "data" || parts[0] === ".workboard" ||
    parts.length === 1 && (parts[0].startsWith(".env") || parts[0].includes(".db"));
}

/** @param {string} directory @returns {Promise<string[]>} */
async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else result.push(file);
  }
  return result;
}

/** @param {string} root @param {{ WORKBOARD_CASEIQ_STATE_ROOT?: string, WORKBOARD_NEXT_DIST_DIR?: string }} [environment] */
export async function protectRuntimeTraces(root, environment = process.env) {
  root = path.resolve(root);
  const output = path.join(root, resolveNextDistDir(environment.WORKBOARD_NEXT_DIST_DIR ?? ""));
  const customRoot = environment.WORKBOARD_CASEIQ_STATE_ROOT
    ? path.resolve(root, environment.WORKBOARD_CASEIQ_STATE_ROOT) : null;
  if (customRoot) {
    const project = path.relative(customRoot, root);
    const build = path.relative(output, customRoot);
    const containsProject = project === "" || project !== ".." && !project.startsWith(`..${path.sep}`) && !path.isAbsolute(project);
    const insideBuild = build === "" || build !== ".." && !build.startsWith(`..${path.sep}`) && !path.isAbsolute(build);
    if (containsProject || insideBuild) throw new Error("CaseIQ runtime storage must not contain the project or use build output.");
  }
  const files = await filesUnder(output);
  const standalone = path.join(output, "standalone");
  const copiedPrivate = files.filter((file) => isPrivateRuntimeAsset(standalone, file));
  if (copiedPrivate.length) {
    throw new Error(`Standalone output already contains ${copiedPrivate.length} private runtime assets. Do not deploy it; rebuild without copying host data.`);
  }
  const hostRoots = [
    path.join(os.homedir(), ".workboard"),
    path.join(os.homedir(), ".copilot"),
    ...(customRoot ? [customRoot] : []),
  ];
  /** @param {string} file */
  const privateAsset = (file) => isPrivateRuntimeAsset(root, file) || hostRoots.some((directory) => {
    const relative = path.relative(directory, file);
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  let removed = 0;
  let traces = 0;
  for (const file of files.filter((file) => file.endsWith(".nft.json"))) {
    const trace = JSON.parse(await readFile(file, "utf8"));
    if (trace === null || typeof trace !== "object" || !Array.isArray(trace.files) ||
        trace.files.some((entry) => typeof entry !== "string")) {
      throw new Error(`Invalid deployment trace: ${path.relative(output, file)}`);
    }
    traces++;
    const retained = trace.files.filter((entry) =>
      !privateAsset(path.resolve(path.dirname(file), entry.replaceAll("/", path.sep))));
    const count = trace.files.length - retained.length;
    if (!count) continue;
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...trace, files: retained }), { flag: "wx" });
    await rename(temporary, file);
    removed += count;
  }
  if (!traces) throw new Error("No deployment traces were produced; private runtime boundaries could not be verified.");
  return { traces, removedPrivateReferences: removed, copiedPrivateAssets: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await protectRuntimeTraces(process.cwd());
  console.log(`[runtime-traces] Checked ${result.traces} traces; removed ${result.removedPrivateReferences} host-private references. Original runtime files were not changed.`);
}
