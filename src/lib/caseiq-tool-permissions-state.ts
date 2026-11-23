import { createHash, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { readCaseIqAuthenticationJson } from "@/lib/caseiq-authentication-state";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import {
  caseIqMcpDefaultsSchema, caseIqMcpServerNameSchema, caseIqMcpToolNameSchema, caseIqSupportIqToolNameSchema,
  type CaseIqMcpDefaults,
} from "@/lib/caseiq-options";
import { getCaseIqStateRoot } from "@/lib/native-runtime-paths";
import { canonicalMcpApprovals, nativeMcpApprovalsSchema, normalizeMcpOverrides } from "../../scripts/native-mcp-permissions.mjs";

const ownerSchema = z.object({
  userId: z.string().min(1), workId: z.string().min(1),
  sessionId: z.uuid(), hostname: z.string().min(1), updatedAt: z.iso.datetime(),
});
const legacyPolicySchema = ownerSchema.extend({
  version: z.literal(1),
  approvedTools: z.array(caseIqSupportIqToolNameSchema).max(64)
    .refine((tools) => new Set(tools).size === tools.length),
  autoApproveSupportIq: z.boolean().default(false),
}).strict();
const currentPolicySchema = ownerSchema.extend({ version: z.literal(2), servers: nativeMcpApprovalsSchema }).strict();
const configurationSchema = z.object({
  defaults: caseIqMcpDefaultsSchema, origin: z.enum(["settings", "legacy"]),
  servers: nativeMcpApprovalsSchema,
}).strict();
const configuredPolicySchema = ownerSchema.extend({ version: z.literal(3), configuration: configurationSchema }).strict();
const policySchema = z.discriminatedUnion("version", [legacyPolicySchema, currentPolicySchema, configuredPolicySchema]);
export type CaseIqToolPermissionPolicy = Pick<z.infer<typeof legacyPolicySchema>, "approvedTools" | "autoApproveSupportIq">;
export type CaseIqMcpPermissionPolicy = z.infer<typeof nativeMcpApprovalsSchema>;
export type CaseIqMcpConfiguration = z.infer<typeof configurationSchema>;

export function caseIqToolPermissionsDirectory() {
  return path.join(getCaseIqStateRoot(), "tool-permissions");
}

function policyFile(workId: string, sessionId: string) {
  const name = createHash("sha256").update(`${workId}\0${sessionId}`).digest("hex");
  return path.join(caseIqToolPermissionsDirectory(), `${name}.json`);
}

export async function readCaseIqMcpConfiguration(userId: string, workId: string, sessionId: string): Promise<CaseIqMcpConfiguration | null> {
  const value = await readCaseIqAuthenticationJson(policyFile(workId, sessionId));
  if (value === null) return null;
  const policy = policySchema.parse(value);
  if (policy.userId !== userId || policy.workId !== workId || policy.sessionId !== sessionId || policy.hostname !== hostname()) {
    throw new CaseIqIntegrationError("CaseIQ tool approvals belong to another user, Work, session or host.", 403);
  }
  if (policy.version === 3) return policy.configuration;
  return {
    defaults: { defaultAutoApprove: false, servers: [] }, origin: "legacy",
    servers: normalizeMcpOverrides(policy.version === 1
      ? [{ serverName: "SupportIQ", approvedTools: policy.approvedTools, autoApprove: policy.autoApproveSupportIq }]
      : policy.servers),
  };
}

export function caseIqMcpConfigurationFromDefaults(settings: CaseIqMcpDefaults, serverNames: readonly string[]): CaseIqMcpConfiguration {
  const names = new Set(["SupportIQ", ...serverNames, ...settings.servers.map((server) => server.serverName)]);
  return configurationSchema.parse({
    origin: "settings", defaults: {
      defaultAutoApprove: settings.defaultAutoApprove,
      servers: [...names].map((serverName) => ({
        serverName, autoApprove: settings.servers.find((server) => server.serverName === serverName)?.autoApprove ?? settings.defaultAutoApprove,
      })),
    }, servers: [],
  });
}

export function caseIqMcpAutomaticMode(configuration: CaseIqMcpConfiguration, serverName: string) {
  return configuration.servers.find((server) => server.serverName === serverName)?.autoApprove ??
    configuration.defaults.servers.find((server) => server.serverName === serverName)?.autoApprove ??
    configuration.defaults.defaultAutoApprove;
}

export function caseIqMcpConfigurationServers(configuration: CaseIqMcpConfiguration, observedServers: readonly string[] = []) {
  return [...new Set(["SupportIQ", ...observedServers, ...configuration.defaults.servers.map((server) => server.serverName),
    ...configuration.servers.map((server) => server.serverName)])];
}

export function caseIqEffectiveMcpApprovals(configuration: CaseIqMcpConfiguration, observedServers: readonly string[] = []) {
  return canonicalMcpApprovals(caseIqMcpConfigurationServers(configuration, observedServers).map((serverName) => ({
    serverName, autoApprove: caseIqMcpAutomaticMode(configuration, serverName),
    approvedTools: configuration.servers.find((server) => server.serverName === serverName)?.approvedTools ?? [],
  })));
}

export async function readCaseIqMcpPermissionPolicy(
  userId: string, workId: string, sessionId: string, observedServers: readonly string[] = [],
): Promise<CaseIqMcpPermissionPolicy> {
  const configuration = await readCaseIqMcpConfiguration(userId, workId, sessionId);
  return configuration ? caseIqEffectiveMcpApprovals(configuration, observedServers) : [];
}

export async function readCaseIqToolPermissionPolicy(userId: string, workId: string, sessionId: string): Promise<CaseIqToolPermissionPolicy> {
  const support = (await readCaseIqMcpPermissionPolicy(userId, workId, sessionId)).find((server) => server.serverName === "SupportIQ");
  return { approvedTools: support?.approvedTools ?? [], autoApproveSupportIq: support?.autoApprove ?? false };
}

export async function readCaseIqToolApprovals(userId: string, workId: string, sessionId: string): Promise<string[]> {
  return (await readCaseIqToolPermissionPolicy(userId, workId, sessionId)).approvedTools;
}

export async function writeCaseIqToolApprovals(
  userId: string, workId: string, sessionId: string, approvedTools: string[], autoApproveSupportIq = false,
) {
  const current = await readCaseIqMcpConfiguration(userId, workId, sessionId) ??
    { defaults: { defaultAutoApprove: false, servers: [] }, origin: "legacy" as const, servers: [] };
  await writeCaseIqMcpConfiguration(userId, workId, sessionId, { ...current, servers: [
    ...current.servers.filter((server) => server.serverName !== "SupportIQ"),
    { serverName: "SupportIQ", approvedTools, autoApprove: autoApproveSupportIq },
  ] });
}

export async function writeCaseIqMcpApprovals(userId: string, workId: string, sessionId: string, servers: CaseIqMcpPermissionPolicy) {
  const current = await readCaseIqMcpConfiguration(userId, workId, sessionId) ??
    { defaults: { defaultAutoApprove: false, servers: [] }, origin: "legacy" as const, servers: [] };
  await writeCaseIqMcpConfiguration(userId, workId, sessionId, { ...current, servers });
}

export async function writeCaseIqMcpConfiguration(userId: string, workId: string, sessionId: string, configuration: CaseIqMcpConfiguration) {
  const policy = configuredPolicySchema.parse({
    version: 3, userId, workId, sessionId, hostname: hostname(), updatedAt: new Date().toISOString(),
    configuration: { ...configuration, servers: normalizeMcpOverrides(configuration.servers) },
  });
  const file = policyFile(workId, sessionId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(policy), { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export function requestedMcpTools(events: readonly unknown[]) {
  const servers = new Map<string, Map<string, { name: string; managed: boolean }>>();
  for (const value of events) {
    const event = z.object({ type: z.string(), data: z.unknown() }).passthrough().parse(value);
    if (event.type !== "permission.requested") continue;
    const { permissionRequest: request } = z.object({
      permissionRequest: z.object({
        kind: z.string(), serverName: z.string().optional(), toolName: z.string().optional(),
        managedApprovalRequired: z.boolean().optional(),
      }).passthrough(),
    }).passthrough().parse(event.data);
    if (request.kind !== "mcp") continue;
    const parsedServer = caseIqMcpServerNameSchema.safeParse(request.serverName);
    if (!parsedServer.success) throw new CaseIqIntegrationError("A native MCP server name cannot be safely represented as a tool approval rule.", 409);
    const serverName = parsedServer.data;
    if (!request.toolName) throw new CaseIqIntegrationError("Native MCP permission request has no tool name.");
    const prefix = `${serverName}-`;
    const parsedTool = caseIqMcpToolNameSchema.safeParse(request.toolName.startsWith(prefix) ? request.toolName.slice(prefix.length) : request.toolName);
    if (!parsedTool.success) throw new CaseIqIntegrationError("A native MCP tool name cannot be safely represented as an exact approval rule.", 409);
    const name = parsedTool.data;
    const tools = servers.get(serverName) ?? new Map<string, { name: string; managed: boolean }>();
    tools.set(name, { name, managed: Boolean(request.managedApprovalRequired) });
    servers.set(serverName, tools);
  }
  return [...servers].map(([serverName, tools]) => ({ serverName, tools: [...tools.values()] }));
}

export function requestedSupportIqTools(events: readonly unknown[]) {
  return requestedMcpTools(events).find((server) => server.serverName === "SupportIQ")?.tools ?? [];
}
