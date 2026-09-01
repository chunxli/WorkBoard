import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, readlink, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { resolveWorkDirectory } from "./work-files";

const PROJECT_SKILL_LOCATIONS = [".github/skills", ".agents/skills", ".claude/skills"];

export interface DiscoveredSkill {
  name: string;
  description: string;
  directoryPath: string;
  skillFilePath: string;
  contentHash: string;
  source: "PROJECT" | "LOCAL";
}

function parseFrontmatter(content: string): { name: string; description: string } {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("SKILL.md must start with YAML frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed");
  const frontmatter = parse(lines.slice(1, end).join("\n")) as Record<string, unknown> | null;
  const name = typeof frontmatter?.name === "string" ? frontmatter.name.trim() : "";
  const description =
    typeof frontmatter?.description === "string" ? frontmatter.description.trim() : "";
  if (!/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new Error("Skill name must contain lowercase letters, numbers, or hyphens only");
  }
  if (!description || description.length > 1024) {
    throw new Error("Skill description must be between 1 and 1024 characters");
  }
  return { name, description };
}

async function hashDirectory(directoryPath: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(currentPath: string, relativePath: string): Promise<void> {
    const entries = await readdir(/* turbopackIgnore: true */ currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(/* turbopackIgnore: true */ currentPath, entry.name);
      const entryRelativePath = path.join(relativePath, entry.name).replaceAll("\\", "/");
      hash.update(`${entry.isSymbolicLink() ? "l" : entry.isDirectory() ? "d" : "f"}:${entryRelativePath}\0`);
      if (entry.isSymbolicLink()) {
        hash.update(await readlink(entryPath));
      } else if (entry.isDirectory()) {
        await visit(entryPath, entryRelativePath);
      } else if (entry.isFile()) {
        hash.update(await readFile(/* turbopackIgnore: true */ entryPath));
      }
      hash.update("\0");
    }
  }

  await visit(directoryPath, "");
  return hash.digest("hex");
}

export async function readSkillDirectory(
  directoryPath: string,
  source: "PROJECT" | "LOCAL"
): Promise<DiscoveredSkill> {
  const resolvedDirectory = resolveWorkDirectory(directoryPath);
  const info = await lstat(/* turbopackIgnore: true */ resolvedDirectory).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Skill directory does not exist: ${resolvedDirectory}`);
  const skillFilePath = path.join(/* turbopackIgnore: true */ resolvedDirectory, "SKILL.md");
  const content = await readFile(/* turbopackIgnore: true */ skillFilePath, "utf8");
  const frontmatter = parseFrontmatter(content);
  return {
    ...frontmatter,
    directoryPath: resolvedDirectory,
    skillFilePath,
    contentHash: await hashDirectory(resolvedDirectory),
    source,
  };
}

async function discoverChildren(
  rootPath: string,
  source: "PROJECT" | "LOCAL"
): Promise<DiscoveredSkill[]> {
  const rootInfo = await lstat(/* turbopackIgnore: true */ rootPath).catch(() => null);
  if (!rootInfo?.isDirectory()) return [];
  if (await lstat(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ rootPath, "SKILL.md")).then((info) => info.isFile()).catch(() => false)) {
    return [await readSkillDirectory(rootPath, source)];
  }

  const entries = await readdir(/* turbopackIgnore: true */ rootPath, { withFileTypes: true });
  const results: DiscoveredSkill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    try {
      results.push(
        await readSkillDirectory(
          path.join(/* turbopackIgnore: true */ rootPath, entry.name),
          source
        )
      );
    } catch {
      // A local collection may contain non-Skill directories; only surface valid Skill roots.
    }
  }
  return results;
}

export async function discoverProjectSkills(workPath: string): Promise<DiscoveredSkill[]> {
  const root = resolveWorkDirectory(workPath);
  const byName = new Map<string, DiscoveredSkill>();
  for (const relativePath of PROJECT_SKILL_LOCATIONS) {
    const skills = await discoverChildren(
      path.join(/* turbopackIgnore: true */ root, relativePath),
      "PROJECT"
    );
    for (const skill of skills) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

export async function discoverLocalSkills(localPath: string): Promise<DiscoveredSkill[]> {
  return discoverChildren(resolveWorkDirectory(localPath), "LOCAL");
}

export async function removeProjectSkills(workPath: string, skillNames: Set<string>): Promise<void> {
  for (const relativePath of PROJECT_SKILL_LOCATIONS) {
    const rootPath = path.join(/* turbopackIgnore: true */ workPath, relativePath);
    const rootInfo = await lstat(/* turbopackIgnore: true */ rootPath).catch(() => null);
    if (!rootInfo?.isDirectory()) continue;
    for (const entry of await readdir(/* turbopackIgnore: true */ rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(/* turbopackIgnore: true */ rootPath, entry.name);
      try {
        const skill = await readSkillDirectory(skillPath, "PROJECT");
        if (skillNames.has(skill.name)) {
          await rm(skillPath, { recursive: true, force: true });
        }
      } catch {
        // Preserve directories that are not valid Skills.
      }
    }
  }
}

export async function installSkillSnapshot(
  sourceDirectory: string,
  variantPath: string,
  skillName: string
): Promise<void> {
  const target = path.join(
    /* turbopackIgnore: true */ variantPath,
    ".github",
    "skills",
    skillName
  );
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(resolveWorkDirectory(sourceDirectory), target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
}
