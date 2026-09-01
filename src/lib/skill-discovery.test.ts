import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverLocalSkills,
  discoverProjectSkills,
  readSkillDirectory,
  removeProjectSkills,
} from "./skill-discovery";
import { detectSkillInvocation } from "./skill-events";

const cleanupPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "work-board-skill-"));
  cleanupPaths.push(directory);
  return directory;
}

async function createSkill(directory: string, name: string, description: string, body: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8"
  );
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("Skill discovery", () => {
  it("uses official project priority and deduplicates matching names", async () => {
    const work = await temporaryDirectory();
    await createSkill(path.join(work, ".agents", "skills", "compare"), "compare", "Agents copy", "A");
    await createSkill(path.join(work, ".claude", "skills", "compare"), "compare", "Claude copy", "B");

    const skills = await discoverProjectSkills(work);

    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("Agents copy");
  });

  it("hashes every resource in the Skill directory deterministically", async () => {
    const root = await temporaryDirectory();
    const skillPath = path.join(root, "example");
    await createSkill(skillPath, "example", "Example skill", "Do work");
    await writeFile(path.join(skillPath, "reference.md"), "version one", "utf8");
    const first = await readSkillDirectory(skillPath, "LOCAL");
    const same = await readSkillDirectory(skillPath, "LOCAL");
    await writeFile(path.join(skillPath, "reference.md"), "version two", "utf8");
    const changed = await readSkillDirectory(skillPath, "LOCAL");

    expect(first.contentHash).toBe(same.contentHash);
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect((await discoverLocalSkills(root))[0].name).toBe("example");
  });

  it("records invocation only from official skill.invoked events", () => {
    const transcript = [
      JSON.stringify({ type: "session.skills_loaded", data: { names: ["example"] } }),
      JSON.stringify({ type: "skill.invoked", data: { name: "example" } }),
    ].join("\n");
    expect(detectSkillInvocation(transcript, "example")).toBe(true);
    expect(detectSkillInvocation(transcript, "other")).toBe(false);
    expect(detectSkillInvocation("plain output", "example")).toBeNull();
  });

  it("removes only compared Skills and preserves unrelated project Skills", async () => {
    const work = await temporaryDirectory();
    const selected = path.join(work, ".github", "skills", "selected");
    const unrelated = path.join(work, ".github", "skills", "unrelated");
    await createSkill(selected, "selected", "Selected skill", "Selected");
    await createSkill(unrelated, "unrelated", "Unrelated skill", "Unrelated");

    await removeProjectSkills(work, new Set(["selected"]));

    expect((await discoverProjectSkills(work)).map((skill) => skill.name)).toEqual(["unrelated"]);
  });
});