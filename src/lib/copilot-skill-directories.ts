import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const settingsSchema = z.object({
  skillDirectories: z.array(z.string().trim().min(1)).optional(),
});

export async function readCopilotSkillDirectories(environment: Partial<NodeJS.ProcessEnv>): Promise<string[] | undefined> {
  const home = environment.COPILOT_HOME ||
    path.join(environment.USERPROFILE || environment.HOME || os.homedir(), ".copilot");
  const file = path.join(home, "settings.json");
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read Copilot skill settings at ${file}.`, { cause: error });
  }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (error) { throw new Error(`Invalid Copilot settings JSON at ${file}.`, { cause: error }); }
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Copilot skillDirectories must be a list of non-empty directory paths in ${file}.`);
  return parsed.data.skillDirectories;
}
