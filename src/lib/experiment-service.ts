import { randomUUID } from "node:crypto";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { jobQueue } from "@/lib/job-queue";
import {
  copyExperimentVariant,
  copyWorkToExperimentBase,
  readWorkPrompt,
} from "@/lib/work-files";
import {
  installSkillSnapshot,
  readSkillDirectory,
  removeProjectSkills,
  type DiscoveredSkill,
} from "@/lib/skill-discovery";
import { createPendingWorkRun, executeWorkRun } from "@/lib/work-executor";

interface CreateExperimentOptions {
  workId: string;
  name?: string;
  skillPaths: string[];
  includeBaseline: boolean;
  invocationMode: "EXPLICIT" | "AUTO";
  engine: "CLI" | "SDK";
}

export async function createAndRunExperiment(options: CreateExperimentOptions): Promise<{
  experimentId: string;
  runIds: string[];
}> {
  const work = await prisma.work.findUniqueOrThrow({ where: { id: options.workId } });
  const skills: DiscoveredSkill[] = [];
  const skillNames = new Set<string>();
  for (const skillPath of options.skillPaths) {
    const skill = await readSkillDirectory(skillPath, "LOCAL");
    if (skillNames.has(skill.name)) throw new Error(`Duplicate Skill name: ${skill.name}`);
    skillNames.add(skill.name);
    skills.push(skill);
  }

  const experimentId = randomUUID();
  const experimentRoot = path.join(
    work.directoryPath,
    ".workboard",
    "variants",
    work.id,
    experimentId
  );
  const basePath = path.join(experimentRoot, "base");
  const variantDefinitions = [
    ...(options.includeBaseline ? [{ id: randomUUID(), skill: null }] : []),
    ...skills.map((skill) => ({ id: randomUUID(), skill })),
  ];

  await prisma.experiment.create({
    data: {
      id: experimentId,
      workId: work.id,
      name: options.name ?? `Skill comparison ${new Date().toLocaleString()}`,
      invocationMode: options.invocationMode,
      engine: options.engine,
      status: "PROVISIONING",
      basePath,
      variants: {
        create: variantDefinitions.map(({ id, skill }) => ({
          id,
          skillName: skill?.name ?? null,
          skillSourcePath: skill?.directoryPath ?? null,
          skillHash: skill?.contentHash ?? null,
          status: "COPYING",
        })),
      },
    },
  });

  try {
    await copyWorkToExperimentBase(work.directoryPath, basePath);
    await removeProjectSkills(basePath, skillNames);

    for (const [index, definition] of variantDefinitions.entries()) {
      const label = definition.skill?.name ?? "no-skill";
      const variantPath = path.join(
        experimentRoot,
        `${String(index + 1).padStart(2, "0")}-${label}`
      );
      await copyExperimentVariant(basePath, variantPath);
      if (definition.skill) {
        await installSkillSnapshot(
          definition.skill.directoryPath,
          variantPath,
          definition.skill.name
        );
        const installed = await readSkillDirectory(
          path.join(variantPath, ".github", "skills", definition.skill.name),
          "PROJECT"
        );
        if (installed.contentHash !== definition.skill.contentHash) {
          throw new Error(`Skill changed while snapshotting: ${definition.skill.name}`);
        }
      }
      await prisma.experimentVariant.update({
        where: { id: definition.id },
        data: { directoryPath: variantPath, status: "READY" },
      });
    }

    const sourcePrompt = (await readWorkPrompt(work)).content;
    const runIds: string[] = [];
    for (const definition of variantDefinitions) {
      const variant = await prisma.experimentVariant.findUniqueOrThrow({
        where: { id: definition.id },
      });
      const prompt =
        definition.skill && options.invocationMode === "EXPLICIT"
          ? `Use the /${definition.skill.name} skill to complete this work.\n\n${sourcePrompt}`
          : sourcePrompt;
      const run = await createPendingWorkRun({
        workId: work.id,
        engine: options.engine,
        executionPath: variant.directoryPath!,
        prompt,
        concurrencyMode: "EXPERIMENT_VARIANT",
        trigger: "EXPERIMENT",
        experimentVariantId: variant.id,
      });
      runIds.push(run.id);
      jobQueue.enqueue(run.id, () => executeWorkRun(run.id));
    }

    await prisma.$transaction([
      prisma.experiment.update({ where: { id: experimentId }, data: { status: "RUNNING" } }),
      prisma.work.update({ where: { id: work.id }, data: { status: "ACTIVE" } }),
    ]);
    return { experimentId, runIds };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    await prisma.$transaction([
      prisma.experiment.update({
        where: { id: experimentId },
        data: { status: "FAILED", errorMessage, finishedAt },
      }),
      prisma.experimentVariant.updateMany({
        where: { experimentId, status: { in: ["COPYING", "READY"] } },
        data: { status: "FAILED", errorMessage },
      }),
    ]);
    throw error;
  }
}