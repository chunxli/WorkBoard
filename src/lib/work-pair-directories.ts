import { lstat, mkdir, realpath, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getCaseIqStateRoot, overlapsPrivateRuntimePath, pathIsWithin } from "@/lib/native-runtime-paths";
import { getDirectorySnapshotPath } from "@/lib/directory-snapshot";
import { getWorkRunArtifactPaths } from "@/lib/run-artifacts";
import {
  pairedLaneInfo, pairedOutputFolder, pairedWorkLane, type PairedWorkLane, type WorkSessionPairIds,
} from "@/lib/work-session-pair";

export type PairWorkspaceWork = { directoryPath: string; sessionPair?: WorkSessionPairIds | null };
export type PairWorkspaceRun = {
  copilotSessionId: string | null; engine: string | null; providerId?: string | null; executionPath: string | null;
};

export class WorkPairError extends Error {
  constructor(message: string, readonly status = 409, options?: ErrorOptions) {
    super(message, options);
  }
}

export function pairedWorkspacePath(root: string, pair: WorkSessionPairIds, lane: PairedWorkLane): string {
  if (!z.uuid().safeParse(pair.cliSessionId).success || !z.uuid().safeParse(pair.caseIqSessionId).success ||
      pair.cliSessionId === pair.caseIqSessionId) throw new WorkPairError("The paired Session IDs are invalid.");
  return path.join(root, pairedOutputFolder(pair), pairedLaneInfo[lane].folder);
}

export function matchesPairedWorkspace(work: { directoryPath: string; sessionPair: WorkSessionPairIds }, run: PairWorkspaceRun): boolean {
  const lane = pairedWorkLane(work.sessionPair, run.copilotSessionId);
  return lane !== null && run.engine === lane && (run.providerId ?? null) === (lane === "CASEIQ" ? "caseiq" : null) &&
    run.executionPath !== null && path.relative(pairedWorkspacePath(work.directoryPath, work.sessionPair, lane), run.executionPath) === "";
}

export async function provisionPairedWorkspaces(root: string, pair: WorkSessionPairIds) {
  const cli = pairedWorkspacePath(root, pair, "CLI");
  const caseIq = pairedWorkspacePath(root, pair, "CASEIQ");
  const created: string[] = [];
  const discardEmpty = async () => {
    for (const directory of created.toReversed()) {
      try { await rmdir(directory); }
      catch (error) {
        console.error("[Work Board] Could not remove an unused empty paired workspace.", error);
      }
    }
  };
  try {
    for (const directory of [path.dirname(cli), cli, caseIq]) {
      await mkdir(/* turbopackIgnore: true */ directory);
      created.push(directory);
    }
  } catch (error) {
    await discardEmpty();
    throw new WorkPairError("Could not create fresh output folders. Existing folders were not adopted.", 409, { cause: error });
  }
  return { cli, caseIq, discardEmpty };
}

async function assertPlainDirectory(directory: string) {
  const info = await lstat(/* turbopackIgnore: true */ directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      path.relative(directory, await realpath(/* turbopackIgnore: true */ directory)) !== "") {
    throw new WorkPairError("A paired output folder was redirected. Restore its original directory before continuing.");
  }
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertPlainIfPresent(directory: string) {
  try { await assertPlainDirectory(directory); }
  catch (error) { if (!missingPath(error)) throw error; }
}

export async function assertPairedInputDirectory(root: string, installationRoot: string, mayCreate = false) {
  let base = root;
  for (;;) {
    try { await assertPlainDirectory(base); break; }
    catch (error) {
      if (!mayCreate || !missingPath(error) || path.dirname(base) === base) {
        if (missingPath(error)) throw new WorkPairError("The original shared Work directory is missing.", 409, { cause: error });
        throw error;
      }
      base = path.dirname(base);
    }
  }
  if (overlapsPrivateRuntimePath(root) ||
      pathIsWithin(installationRoot, root) || pathIsWithin(root, installationRoot)) {
    throw new WorkPairError("Choose a Work directory separate from the CaseIQ checkout and private runtime data.");
  }
  await assertPlainIfPresent(path.join(root, ".workboard"));
}

export async function verifyPairedWorkspaces(root: string, pair: WorkSessionPairIds, lanes: readonly PairedWorkLane[]) {
  if (overlapsPrivateRuntimePath(root)) {
    throw new WorkPairError("Paired Sessions require a Work folder separate from private runtime storage.");
  }
  try {
    await assertPlainDirectory(root);
    await assertPlainDirectory(path.join(root, pairedOutputFolder(pair)));
    for (const lane of lanes) await assertPlainDirectory(pairedWorkspacePath(root, pair, lane));
  } catch (error) {
    if (missingPath(error)) throw new WorkPairError("A paired output folder or its shared Work directory is missing.", 409, { cause: error });
    throw error;
  }
}

async function verifyPairedRunOutput(work: PairWorkspaceWork, run: PairWorkspaceRun & { id: string }) {
  const pair = work.sessionPair;
  if (!pair) return null;
  const lane = pairedWorkLane(pair, run.copilotSessionId);
  if (!lane || !matchesPairedWorkspace({ ...work, sessionPair: pair }, run)) {
    throw new WorkPairError("This Run does not match its saved paired workspace.");
  }
  await verifyPairedWorkspaces(work.directoryPath, pair, [lane]);
  const directory = pairedWorkspacePath(work.directoryPath, pair, lane);
  const paths = getWorkRunArtifactPaths(directory, z.uuid().parse(run.id));
  for (const folder of [path.join(directory, ".workboard"), path.join(directory, ".workboard", "outputs"), paths.outputDirectory]) {
    await assertPlainIfPresent(folder);
  }
  return { directory, paths };
}

export async function resolveRunCompletionArtifactPaths(
  work: PairWorkspaceWork,
  run: PairWorkspaceRun & { id: string; outputDir: string | null },
) {
  const output = await verifyPairedRunOutput(work, run);
  const { outputDirectory, snapshot, result } = output?.paths ?? getWorkRunArtifactPaths(work.directoryPath, run.id);
  if (!run.outputDir || path.relative(run.outputDir, outputDirectory) !== "") {
    throw new WorkPairError("CaseIQ completion artifacts are outside the saved Run directory.");
  }
  return { snapshot, result };
}

export async function verifyPairedRunDirectory(work: PairWorkspaceWork, run: PairWorkspaceRun & { id: string }) {
  const output = await verifyPairedRunOutput(work, run);
  if (!output) return work.directoryPath;
  const { directory, paths } = output;
  await assertPlainIfPresent(path.join(directory, ".workboard", "tmp"));
  await assertPlainIfPresent(path.join(directory, ".workboard", "tmp", "run-snapshots"));
  const files = [paths.result, paths.transcript, paths.diff, paths.snapshot, paths.stdout, paths.stderr,
    getDirectorySnapshotPath(directory, run.id)];
  await Promise.all(files.flatMap((file) => [file, `${file}.tmp`]).map(async (file) => {
    try {
      const info = await lstat(/* turbopackIgnore: true */ file);
      if (!info.isFile() || info.isSymbolicLink()) throw new WorkPairError("A paired Run artifact was redirected.");
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
  }));
  return directory;
}

export async function assertPairedRunArtifactLocation(
  work: PairWorkspaceWork | null,
  run: PairWorkspaceRun & { id: string; outputDir: string | null; logPath?: string | null },
) {
  if (!work?.sessionPair) return;
  const root = await verifyPairedRunDirectory(work, run);
  const expected = getWorkRunArtifactPaths(root, run.id);
  if (!run.outputDir || path.relative(run.outputDir, expected.outputDirectory) !== "" ||
      run.logPath && path.relative(run.logPath, expected.stdout) !== "") {
    throw new WorkPairError("Run artifacts do not match the saved paired workspace.");
  }
}

export interface PairedCopilotWorkspace {
  inputDirectory: string;
  instructionDirectory: string;
}

export function workspaceInstructionEnvironment(environment: NodeJS.ProcessEnv, workspace?: PairedCopilotWorkspace): NodeJS.ProcessEnv {
  if (!workspace) return environment;
  if (workspace.instructionDirectory.includes(path.delimiter)) {
    throw new WorkPairError("The paired instruction directory cannot be represented in Copilot's instruction search path.");
  }
  return {
    ...environment,
    COPILOT_CUSTOM_INSTRUCTIONS_DIRS: [environment.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, workspace.instructionDirectory].filter(Boolean).join(path.delimiter),
  };
}

export async function writePairedWorkspaceInstructions(root: string, output: string, runId: string,
  ensurePrivateDirectory: (directory: string) => Promise<void>): Promise<PairedCopilotWorkspace> {
  const directory = path.join(getCaseIqStateRoot(), "paired-instructions", z.uuid().parse(runId));
  await ensurePrivateDirectory(directory);
  await writeFile(path.join(directory, "workboard-paired.instructions.md"), [
    "---", 'applyTo: "**"', "---", "",
    `Shared input directory: ${JSON.stringify(root)}.`,
    `This Session's working and output directory: ${JSON.stringify(output)}.`,
    "Resolve referenced input files in the shared input directory, using their absolute paths. Treat shared inputs as read-only.",
    "Keep every generated file, report, edit and intermediate result inside this Session's output directory.",
    "Do not write to the shared input directory, the other Session's output folder, or Work Board bookkeeping files.",
  ].join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  return { inputDirectory: root, instructionDirectory: directory };
}
