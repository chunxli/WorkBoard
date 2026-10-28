import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCopilotSkillDirectories } from "./copilot-skill-directories";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "workboard-skill-settings-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("user-configured Copilot skill directories", () => {
  it("reads the same configured skill directory list as the interactive CLI", async () => {
    const skillDirectories = [path.join(root, "skills with spaces"), path.join(root, "other")];
    await writeFile(path.join(root, "settings.json"), JSON.stringify({ skillDirectories, unrelatedSetting: true }));
    expect(await readCopilotSkillDirectories({ COPILOT_HOME: root })).toEqual(skillDirectories);
  });

  it("uses the user's default Copilot home when no override is set", async () => {
    await mkdir(path.join(root, ".copilot"));
    await writeFile(path.join(root, ".copilot", "settings.json"), JSON.stringify({ skillDirectories: ["C:\\synthetic\\skills"] }));
    expect(await readCopilotSkillDirectories({ USERPROFILE: root })).toEqual(["C:\\synthetic\\skills"]);
  });

  it("keeps default runtime discovery when settings or skillDirectories are absent", async () => {
    expect(await readCopilotSkillDirectories({ COPILOT_HOME: root })).toBeUndefined();
    await writeFile(path.join(root, "settings.json"), "{}");
    expect(await readCopilotSkillDirectories({ COPILOT_HOME: root })).toBeUndefined();
  });

  it("preserves an explicitly empty directory list", async () => {
    await writeFile(path.join(root, "settings.json"), '{"skillDirectories":[]}');
    expect(await readCopilotSkillDirectories({ COPILOT_HOME: root })).toEqual([]);
  });

  it.each(['{invalid', '{"skillDirectories":"not-a-list"}', '{"skillDirectories":[""]}'])(
    "reports malformed settings instead of silently omitting configured skills: %s", async (contents) => {
      await writeFile(path.join(root, "settings.json"), contents);
      await expect(readCopilotSkillDirectories({ COPILOT_HOME: root })).rejects.toThrow(/Invalid Copilot settings JSON|skillDirectories must be/);
    },
  );
});
