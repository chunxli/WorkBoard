import { ensurePrivateRuntimeDirectory } from "@/lib/caseiq-integration";
import { activeCaseIqWorkReason, resolveCaseIqSessionOwner } from "@/lib/caseiq-authentication";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import {
  caseIqMcpPermissionStatusSchema, caseIqMcpRequestedToolsSchema, caseIqMcpServerNameSchema, caseIqMcpToolNameSchema,
  caseIqToolPermissionStatusSchema, type CaseIqMcpPermissionDecision, type CaseIqMcpPermissionStatus, type CaseIqToolPermissionStatus,
} from "@/lib/caseiq-options";
import {
  assertCopilotSessionNotInUse, CopilotSessionInUseError, readCompatibleCopilotSessionEvents,
} from "@/lib/copilot-session-compat";
import { nativeSessionBindingHome } from "@/lib/native-session-bindings";
import { caseIqAuthenticationBlockedReason } from "@/lib/caseiq-authentication-state";
import { withRunStartLock } from "@/lib/run-start-lock";
import {
  caseIqMcpAutomaticMode, caseIqMcpConfigurationServers, caseIqToolPermissionsDirectory,
  readCaseIqMcpConfiguration, requestedMcpTools, writeCaseIqMcpConfiguration,
} from "@/lib/caseiq-tool-permissions-state";
import { newCaseIqMcpConfiguration } from "@/lib/caseiq-mcp-sessions";

async function inspectMcpPermissions(
  userId: string, workId: string, runId: string, local: boolean,
) {
  const { work, run, binding } = await resolveCaseIqSessionOwner(userId, workId, runId);
  const configuration = await readCaseIqMcpConfiguration(userId, workId, binding.sessionId) ?? await newCaseIqMcpConfiguration(userId);
  const requested = requestedMcpTools(await readCompatibleCopilotSessionEvents(binding.sessionId));
  const names = caseIqMcpConfigurationServers(configuration, requested.map((server) => server.serverName));
  const servers = names.map((serverName) => {
    const approved = configuration.servers.find((server) => server.serverName === serverName);
    const tools = new Map((requested.find((server) => server.serverName === serverName)?.tools ?? [])
      .map((tool) => [tool.name, { ...tool, approved: approved?.approvedTools.includes(tool.name) ?? false }]));
    for (const name of approved?.approvedTools ?? []) {
      if (!tools.has(name)) tools.set(name, { name, approved: true, managed: false });
    }
    return { serverName, autoApprove: caseIqMcpAutomaticMode(configuration, serverName), tools: [...tools.values()] };
  });
  const blockedReason = !local ? "Change tool approvals on the Work's local Windows host."
    : work.status === "ARCHIVED" ? "Restore this Work before changing tool approvals."
      : await caseIqAuthenticationBlockedReason([`work:${workId}`, `session:${binding.sessionId}`])
        ?? ((await activeCaseIqWorkReason(workId, binding.sessionId, run.id, work))
          ? "Wait for this Work's Runs and queued messages to finish before changing tool approvals." : null);
  const status = caseIqMcpPermissionStatusSchema.parse({
    sessionId: binding.sessionId, available: blockedReason === null, blockedReason,
    servers,
  });
  return { configuration, status };
}

export async function getCaseIqMcpPermissionStatus(
  userId: string, workId: string, runId: string, local: boolean,
): Promise<CaseIqMcpPermissionStatus> {
  return (await inspectMcpPermissions(userId, workId, runId, local)).status;
}

function supportIqStatus(status: CaseIqMcpPermissionStatus): CaseIqToolPermissionStatus {
  const support = status.servers.find((server) => server.serverName === "SupportIQ");
  if (!support) throw new CaseIqIntegrationError("The legacy SupportIQ permission state is unavailable.");
  return caseIqToolPermissionStatusSchema.parse({
    sessionId: status.sessionId, available: status.available, blockedReason: status.blockedReason,
    autoApproveSupportIq: support.autoApprove, tools: support.tools,
  });
}

export async function getCaseIqToolPermissionStatus(userId: string, workId: string, runId: string, local: boolean) {
  return supportIqStatus(await getCaseIqMcpPermissionStatus(userId, workId, runId, local));
}

export async function setCaseIqToolPermission(userId: string, workId: string, runId: string, toolName: string, approved: boolean) {
  return supportIqStatus(await setCaseIqMcpToolPermission(userId, workId, runId, "SupportIQ", toolName, approved));
}

export async function approveCaseIqRequestedTools(userId: string, workId: string, runId: string, toolNames: string[]) {
  return supportIqStatus(await approveCaseIqMcpRequestedTools(userId, workId, runId, "SupportIQ", toolNames));
}

export async function setCaseIqAutomaticToolApproval(userId: string, workId: string, runId: string, enabled: boolean) {
  return supportIqStatus(await setCaseIqMcpAutomaticApproval(userId, workId, runId, "SupportIQ", enabled));
}

export async function setCaseIqMcpToolPermission(
  userId: string, workId: string, runId: string, serverName: string, toolName: string, approved: boolean,
) {
  return updateCaseIqMcpPermissions(userId, workId, runId, {
    serverName: caseIqMcpServerNameSchema.parse(serverName), toolName: caseIqMcpToolNameSchema.parse(toolName), approved,
  });
}

export async function approveCaseIqMcpRequestedTools(
  userId: string, workId: string, runId: string, serverName: string, toolNames: string[],
) {
  return updateCaseIqMcpPermissions(userId, workId, runId, {
    serverName: caseIqMcpServerNameSchema.parse(serverName), action: "approve-requested",
    toolNames: caseIqMcpRequestedToolsSchema.parse(toolNames),
  });
}

export async function setCaseIqMcpAutomaticApproval(
  userId: string, workId: string, runId: string, serverName: string, enabled: boolean,
) {
  return updateCaseIqMcpPermissions(userId, workId, runId, {
    serverName: caseIqMcpServerNameSchema.parse(serverName), action: "set-automatic", enabled,
  });
}

async function updateCaseIqMcpPermissions(
  userId: string, workId: string, runId: string, decision: CaseIqMcpPermissionDecision,
) {
  const owner = await resolveCaseIqSessionOwner(userId, workId, runId);
  return withRunStartLock([`work:${workId}`, `session:${owner.binding.sessionId}`], async () => {
    const { configuration, status } = await inspectMcpPermissions(userId, workId, runId, true);
    if (status.sessionId !== owner.binding.sessionId) {
      throw new CaseIqIntegrationError("The CaseIQ session changed. Refresh tool approvals before deciding.", 409);
    }
    if (!status.available) throw new CaseIqIntegrationError(status.blockedReason ?? "Tool approvals are currently unavailable.", 409);
    const server = status.servers.find((entry) => entry.serverName === decision.serverName);
    if (!server) throw new CaseIqIntegrationError("Approve only an MCP observed in this Work's native session.", 400);
    if (!("action" in decision) || decision.action === "approve-requested") {
      if (server.autoApprove) {
        throw new CaseIqIntegrationError(`Turn off automatic ${server.serverName} approval before managing individual tools.`, 409);
      }
      const names = "action" in decision ? decision.toolNames : [decision.toolName];
      for (const name of names) {
        const tool = server.tools.find((entry) => entry.name === name);
        if (!tool) throw new CaseIqIntegrationError("Approve only a tool requested by this Work's native MCP session.", 400);
        if (tool.managed && ("action" in decision || decision.approved)) {
          throw new CaseIqIntegrationError("This tool requires organization-managed approval; a local allow rule cannot replace it.", 409);
        }
      }
    }
    const home = nativeSessionBindingHome(owner.binding);
    if (home === null) throw new CaseIqIntegrationError("The original CaseIQ home is unavailable.");
    try { await assertCopilotSessionNotInUse(owner.binding.sessionId, home); }
    catch (error) {
      if (error instanceof CopilotSessionInUseError) throw new CaseIqIntegrationError("Exit the original CaseIQ session before changing tool approvals.", 409);
      throw error;
    }
    const current = configuration.servers.find((entry) => entry.serverName === server.serverName) ??
      { serverName: server.serverName, approvedTools: [], autoApprove: server.autoApprove };
    const tools = new Set(current.approvedTools);
    if ("action" in decision) {
      if (decision.action === "set-automatic") current.autoApprove = decision.enabled;
      else for (const name of decision.toolNames) tools.add(name);
    } else if (decision.approved) tools.add(decision.toolName);
    else tools.delete(decision.toolName);
    await ensurePrivateRuntimeDirectory(caseIqToolPermissionsDirectory());
    await writeCaseIqMcpConfiguration(userId, workId, owner.binding.sessionId, { ...configuration, servers: [
      ...configuration.servers.filter((entry) => entry.serverName !== server.serverName),
      { ...current, approvedTools: [...tools].sort() },
    ] });
    return getCaseIqMcpPermissionStatus(userId, workId, runId, true);
  });
}
