import { hostname } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { caseIqMcpSessionIndexSchema } from "@/lib/caseiq-options";
import { copilotSessionHasHistory, readCompatibleCopilotSessionEvents } from "@/lib/copilot-session-compat";
import { nativeSessionBindingHome, readNativeSessionBindingSync } from "@/lib/native-session-bindings";
import { getCaseIqStateRoot, pathIsWithin } from "@/lib/native-runtime-paths";
import { readCaseIqMcpDefaults } from "@/lib/caseiq-mcp-defaults-state";
import {
  caseIqMcpConfigurationFromDefaults, readCaseIqMcpConfiguration, requestedMcpTools,
} from "@/lib/caseiq-tool-permissions-state";

export async function listCaseIqMcpSessions(userId: string) {
  const runs = await prisma.run.findMany({
    where: {
      engine: "CASEIQ", providerId: "caseiq", hostname: hostname(), copilotSessionId: { not: null },
      experimentVariantId: null, work: { userId },
    },
    select: { id: true, workId: true, copilotSessionId: true, createdAt: true,
      work: { select: { name: true, hostname: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], distinct: ["copilotSessionId"],
  });
  const sessions = [];
  for (const run of runs) {
    if (!run.work || !run.workId || !run.copilotSessionId) {
      throw new CaseIqIntegrationError("A CaseIQ session is missing its owning Work.");
    }
    let reason: string | null = null;
    try {
      const binding = readNativeSessionBindingSync(run.copilotSessionId);
      const home = binding ? nativeSessionBindingHome(binding) : null;
      if (!binding || binding.userId !== userId || binding.workId !== run.workId ||
          run.work.hostname && run.work.hostname !== hostname() ||
          home === null || !pathIsWithin(path.join(getCaseIqStateRoot(), "native", run.copilotSessionId), home)) {
        reason = "The original session is not ready on this host.";
      } else if (!await copilotSessionHasHistory(run.copilotSessionId, home)) {
        reason = "The original native history is not available yet.";
      }
    } catch (error) {
      console.error("[CaseIQ] MCP session metadata could not be inspected.", error);
      reason = "Session metadata could not be verified. Inspect local diagnostics.";
    }
    sessions.push({
      workId: run.workId, workName: run.work.name, runId: run.id, sessionId: run.copilotSessionId,
      createdAt: run.createdAt.toISOString(), ready: reason === null, reason,
    });
  }
  return caseIqMcpSessionIndexSchema.parse({ sessions });
}

export async function discoverCaseIqMcpServers(userId: string) {
  const index = await listCaseIqMcpSessions(userId);
  const names = new Set(["SupportIQ"]);
  const warnings: string[] = [];
  for (const session of index.sessions.filter((entry) => entry.ready)) {
    try {
      const binding = readNativeSessionBindingSync(session.sessionId);
      const home = binding ? nativeSessionBindingHome(binding) : null;
      if (!home) throw new CaseIqIntegrationError("The original session home changed.");
      const requested = requestedMcpTools(await readCompatibleCopilotSessionEvents(session.sessionId, home));
      for (const server of requested) names.add(server.serverName);
      const configuration = await readCaseIqMcpConfiguration(userId, session.workId, session.sessionId);
      for (const server of configuration?.servers ?? []) names.add(server.serverName);
      for (const server of configuration?.defaults.servers ?? []) names.add(server.serverName);
    } catch (error) {
      console.error("[CaseIQ] MCP catalog discovery failed for an owned session.", error);
      warnings.push(`MCP discovery for session ${session.sessionId.slice(0, 8)} is incomplete. Inspect local diagnostics.`);
    }
  }
  return { serverNames: [...names].sort(), warnings };
}

export async function newCaseIqMcpConfiguration(userId: string) {
  const [settings, catalog] = await Promise.all([readCaseIqMcpDefaults(userId), discoverCaseIqMcpServers(userId)]);
  if (catalog.warnings.length) throw new CaseIqIntegrationError("MCP defaults discovery is incomplete. Open MCP configuration and resolve the reported diagnostics before initializing a new Work/session.");
  return caseIqMcpConfigurationFromDefaults(settings, catalog.serverNames);
}
