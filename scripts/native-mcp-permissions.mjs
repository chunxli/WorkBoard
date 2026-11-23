import { z } from "zod";

const reservedKinds = new Set(["shell", "read", "write", "url", "memory", "custom-tool"]);
export const nativeMcpServerNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
  .refine((value) => !reservedKinds.has(value.toLowerCase()), "An MCP name must not select a built-in permission kind.");
export const nativeMcpToolNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
export const nativeMcpApprovedToolsSchema = z.array(nativeMcpToolNameSchema).max(64)
  .refine((tools) => new Set(tools).size === tools.length);
export const nativeMcpApprovalSchema = z.object({
  serverName: nativeMcpServerNameSchema,
  approvedTools: nativeMcpApprovedToolsSchema.default([]),
  autoApprove: z.boolean().default(false),
}).strict();
export const nativeMcpApprovalsSchema = z.array(nativeMcpApprovalSchema).max(64)
  .refine((servers) => new Set(servers.map((server) => server.serverName)).size === servers.length);

export function normalizeMcpOverrides(value) {
  return nativeMcpApprovalsSchema.parse(value)
    .map((server) => ({ ...server, approvedTools: [...server.approvedTools].sort() }))
    .sort((left, right) => left.serverName < right.serverName ? -1 : left.serverName > right.serverName ? 1 : 0);
}

export function canonicalMcpApprovals(value) {
  return normalizeMcpOverrides(value).filter((server) => server.autoApprove || server.approvedTools.length);
}

export function nativeMcpPermissionRules(value) {
  return canonicalMcpApprovals(value).flatMap((server) => server.autoApprove
    ? [server.serverName]
    : server.approvedTools.map((tool) => `${server.serverName}(${tool})`));
}
