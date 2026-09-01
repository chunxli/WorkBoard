import { prisma } from "@/lib/prisma";
import { normalizeExecutionDefaults } from "@/lib/execution-defaults";

export async function getUserExecutionDefaults(userId: string) {
  const stored = await prisma.userExecutionSettings.findUnique({ where: { userId } });
  return normalizeExecutionDefaults(stored);
}