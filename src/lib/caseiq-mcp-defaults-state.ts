import { createHash, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { readCaseIqAuthenticationJson } from "@/lib/caseiq-authentication-state";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { caseIqMcpDefaultsSchema, type CaseIqMcpDefaults } from "@/lib/caseiq-options";
import { getCaseIqStateRoot } from "@/lib/native-runtime-paths";

const storedDefaultsSchema = z.object({
  version: z.literal(1), userId: z.string().min(1), hostname: z.string().min(1),
  updatedAt: z.iso.datetime(), settings: caseIqMcpDefaultsSchema,
}).strict();

export function caseIqMcpDefaultsDirectory() {
  return path.join(getCaseIqStateRoot(), "mcp-defaults");
}

function defaultsFile(userId: string) {
  const name = createHash("sha256").update(`${userId}\0${hostname()}`).digest("hex");
  return path.join(caseIqMcpDefaultsDirectory(), `${name}.json`);
}

export async function readCaseIqMcpDefaults(userId: string): Promise<CaseIqMcpDefaults> {
  const value = await readCaseIqAuthenticationJson(defaultsFile(userId));
  if (value === null) return { defaultAutoApprove: true, servers: [] };
  const stored = storedDefaultsSchema.parse(value);
  if (stored.userId !== userId || stored.hostname !== hostname()) {
    throw new CaseIqIntegrationError("MCP defaults belong to another user or host.", 403);
  }
  return stored.settings;
}

export async function writeCaseIqMcpDefaults(userId: string, settings: CaseIqMcpDefaults) {
  const stored = storedDefaultsSchema.parse({
    version: 1, userId, hostname: hostname(), updatedAt: new Date().toISOString(), settings,
  });
  const file = defaultsFile(userId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}
