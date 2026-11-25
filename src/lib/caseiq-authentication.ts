import { randomUUID } from "node:crypto";
import { realpath, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { v5 as uuidV5 } from "uuid";
import { prisma } from "@/lib/prisma";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import {
  acceptCaseIqAuthentication, ensurePrivateRuntimeDirectory, prepareCaseIqAuthentication, type CaseIqAuthenticationSpec,
} from "@/lib/caseiq-integration";
import { assertCopilotSessionNotInUse, copilotSessionHasHistory, CopilotSessionInUseError, readCopilotSessionSnapshot } from "@/lib/copilot-session-compat";
import { isNativeCopilotRunActive } from "@/lib/copilot-runner";
import { buildCaseIqEnvironment } from "@/lib/caseiq-runner";
import { getCaseIqInstallationPaths } from "@/lib/caseiq-installation";
import { nativeBindingCompatibilityKey } from "@/lib/native-session-identity";
import { nativeSessionBindingHome, readNativeSessionBindingSync } from "@/lib/native-session-bindings";
import { matchesPairedWorkspace, verifyPairedRunDirectory, WorkPairError, type PairWorkspaceWork } from "@/lib/work-pair-directories";
import { withRunStartLock } from "@/lib/run-start-lock";
import { spawnDetached } from "@/lib/terminal-resume";
import {
  caseIqAuthenticationActivity, caseIqAuthenticationDirectory, readCaseIqAuthentication,
  readCaseIqNativeConnection, writeCaseIqAuthentication, type StoredCaseIqAuthentication,
} from "@/lib/caseiq-authentication-state";
import { cleanStaleCopilotCredentials, inspectWindowsCredentialManager } from "@/lib/windows-credential-manager";
import type { CaseIqAuthenticationStatus } from "@/lib/caseiq-options";

const nativeAuthenticationSignalSchema = z.object({
  id: z.string().optional(), timestamp: z.iso.datetime({ offset: true }), type: z.string(), data: z.unknown(),
});

function latestSupportIqAuthenticationSignal(events: unknown[], bounds?: { since: number; until: number }) {
  let latest: { id: string; timestamp: string } | null = null;
  for (const event of events) {
    const parsed = nativeAuthenticationSignalSchema.safeParse(event);
    if (!parsed.success || Date.parse(parsed.data.timestamp) > Date.now() + 5000) continue;
    const time = Date.parse(parsed.data.timestamp);
    if (bounds && (time < bounds.since || time > bounds.until)) continue;
    const { type, data, timestamp, id } = parsed.data;
    let required = false;
    if (type === "tool.execution_complete") {
      const completion = z.object({ success: z.literal(false), error: z.object({ message: z.string() }) }).safeParse(data);
      required = completion.success && /MCP server ['"]SupportIQ['"] requires authentication\b/i.test(completion.data.error.message);
    } else if (type === "mcp.oauth_required") {
      required = z.object({ serverName: z.literal("SupportIQ") }).safeParse(data).success;
    } else if (type === "session.mcp_server_status_changed") {
      required = z.object({ serverName: z.literal("SupportIQ"), status: z.literal("needs-auth") }).safeParse(data).success;
    } else if (type === "session.mcp_servers_loaded") {
      const servers = z.object({ servers: z.array(z.object({ name: z.string(), status: z.string() })) }).safeParse(data);
      required = servers.success && servers.data.servers.some((server) => server.name === "SupportIQ" && server.status === "needs-auth");
    }
    if (required && (latest === null || Date.parse(timestamp) >= Date.parse(latest.timestamp))) {
      latest = { id: id ?? `${type}:${timestamp}`, timestamp };
    }
  }
  return latest;
}

export function supportIqAuthenticationRejectedAt(events: unknown[], verifiedAt: string): string | null {
  const signal = latestSupportIqAuthenticationSignal(events);
  return signal && Date.parse(signal.timestamp) > Date.parse(verifiedAt) ? signal.timestamp : null;
}

async function automaticSignInRequirement(userId: string, workId: string, sessionId: string,
  run: { id: string; status: string; startedAt: Date | null; finishedAt: Date | null },
  operation: StoredCaseIqAuthentication | null, verifiedAt: string | null) {
  if (!run.startedAt || !run.finishedAt && run.status !== "RUNNING") return null;
  let events: unknown[];
  try { events = (await readCopilotSessionSnapshot(sessionId)).events; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const signal = latestSupportIqAuthenticationSignal(events, {
    since: run.startedAt.getTime(), until: run.finishedAt?.getTime() ?? Infinity,
  });
  if (!signal) return null;
  return {
    requestId: uuidV5(JSON.stringify(["workboard-supportiq-signin", userId, workId, sessionId, run.id, signal.id, signal.timestamp]), uuidV5.URL),
    requiredAt: signal.timestamp,
    attempted: Boolean(operation?.sessionId === sessionId && Date.parse(operation.startedAt) >= Date.parse(signal.timestamp) ||
      verifiedAt && Date.parse(verifiedAt) >= Date.parse(signal.timestamp)),
  };
}

export async function resolveCaseIqSessionOwner(userId: string, workId: string, runId: string) {
  const work = await prisma.work.findFirst({
    where: { id: workId, userId }, select: { id: true, hostname: true, status: true, directoryPath: true, sessionPair: true },
  });
  if (!work) throw new CaseIqIntegrationError("Work not found.", 404);
  const run = await prisma.run.findFirst({
    where: { id: runId, workId, experimentVariantId: null },
    select: { id: true, status: true, hostname: true, engine: true, providerId: true, copilotSessionId: true,
      startedAt: true, finishedAt: true, executionPath: true },
  });
  if (!run || run.engine !== "CASEIQ" || run.providerId !== "caseiq" || !run.copilotSessionId) {
    throw new CaseIqIntegrationError("Select a CaseIQ web Run with an existing native session.");
  }
  if (run.hostname !== hostname() || work.hostname && work.hostname !== hostname()) {
    throw new CaseIqIntegrationError("Sign in on the Work's owning Windows host.");
  }
  const binding = readNativeSessionBindingSync(run.copilotSessionId);
  let workingDirectory;
  try {
    workingDirectory = work.sessionPair ? await verifyPairedRunDirectory(work, run)
      : await realpath(/* turbopackIgnore: true */ work.directoryPath);
  } catch (error) {
    if (error instanceof WorkPairError) throw new CaseIqIntegrationError(error.message);
    throw error;
  }
  if (!binding || binding.userId !== userId || binding.workId !== workId ||
      path.relative(binding.workingDirectory, workingDirectory) !== "" || nativeSessionBindingHome(binding) === null) {
    throw new CaseIqIntegrationError("The original CaseIQ binding is unavailable. No other session will be used.");
  }
  const installation = await getCaseIqInstallationPaths();
  if (nativeBindingCompatibilityKey(binding) !== nativeBindingCompatibilityKey({ ...binding, ...installation })) {
    throw new CaseIqIntegrationError("The configured CaseIQ installation location changed. Sign-in requires the original Session's installation paths.");
  }
  return { work, workingDirectory, run, binding };
}

export async function activeCaseIqWorkReason(workId: string, sessionId: string, runId: string, work?: PairWorkspaceWork): Promise<string | null> {
  if (work?.sessionPair?.caseIqSessionId === sessionId) {
    const workspace = { directoryPath: work.directoryPath, sessionPair: work.sessionPair };
    const active = await prisma.run.findMany({
      where: { status: { in: ["PENDING", "RUNNING"] }, OR: [{ workId }, { copilotSessionId: sessionId }] },
      select: { workId: true, copilotSessionId: true, engine: true, providerId: true, executionPath: true,
        hostname: true, taskId: true, experimentVariantId: true, trigger: true },
    });
    const blockingRun = active.some((run) =>
      run.workId !== workId || run.copilotSessionId !== workspace.sessionPair.cliSessionId || run.hostname !== hostname() ||
      run.taskId || run.experimentVariantId || !["WORK", "FOLLOW_UP"].includes(run.trigger) || !matchesPairedWorkspace(workspace, run));
    return blockingRun || isNativeCopilotRunActive(runId)
      ? "Wait for CaseIQ's Runs and queued messages to finish before signing in." : null;
  }
  const count = await prisma.run.count({
    where: { status: { in: ["PENDING", "RUNNING"] }, OR: [{ workId }, { copilotSessionId: sessionId }] },
  });
  return count || isNativeCopilotRunActive(runId) ? "Wait for this Work's Runs and queued messages to finish before signing in." : null;
}

export async function getCaseIqAuthenticationStatus(
  userId: string, workId: string, runId: string, local: boolean,
): Promise<CaseIqAuthenticationStatus> {
  const { work, run, binding } = await resolveCaseIqSessionOwner(userId, workId, runId);
  const operation = await readCaseIqAuthentication(workId);
  if (operation && operation.userId !== userId) throw new CaseIqIntegrationError("Authentication belongs to another user.", 403);
  const activity = operation ? await caseIqAuthenticationActivity(operation) : null;
  let connection = operation && operation.sessionId === binding.sessionId
    ? await readCaseIqNativeConnection(operation, binding.oauthStorage) : { status: "unknown" as const, toolCount: null, checkedAt: null };
  const automaticSignIn = await automaticSignInRequirement(userId, workId, binding.sessionId, run, operation,
    connection.status === "connected" ? connection.checkedAt : null);
  if (automaticSignIn && !automaticSignIn.attempted && (connection.status !== "connected" || !connection.checkedAt ||
      Date.parse(automaticSignIn.requiredAt) > Date.parse(connection.checkedAt))) {
    connection = { status: "needs-auth", toolCount: null, checkedAt: automaticSignIn.requiredAt };
  }
  const relevantActivity = operation?.sessionId === binding.sessionId || activity?.reserved ? activity : null;
  const state = relevantActivity && connection.status === "connected" ? {
    ...relevantActivity,
    message: relevantActivity.reserved
      ? "SupportIQ native connection and tools were verified. Exit Copilot to release this Work for Follow Up."
      : `SupportIQ native connection and tools were last verified at ${connection.checkedAt}. ${relevantActivity.status === "failed"
        ? "The authentication window ended with an error" : "The authentication window is closed"}; its reservation is released. This is previous verification, not an active MCP connection.`,
  } : relevantActivity;
  const blockedReason = !local ? "Open this Work on its local Windows host to sign in."
    : work.status === "ARCHIVED" ? "Restore this Work before signing in."
      : state?.reserved ? state.message
        : await activeCaseIqWorkReason(workId, binding.sessionId, run.id, work);
  const credentialManager = local
    ? await inspectWindowsCredentialManager({
        sessionHome: nativeSessionBindingHome(binding),
        verifiedAt: connection.status === "connected" ? connection.checkedAt : null,
      }).catch(() => null)
    : null;
  return { sessionId: binding.sessionId, available: blockedReason === null, blockedReason,
    authenticationVerified: connection.status === "connected", connection, operation: state,
    ...(credentialManager ? { credentialManager } : {}),
    ...(binding.oauthStorage ? { oauthStorage: { mode: binding.oauthStorage.mode, reason: binding.oauthStorage.reason } } : {}),
    automaticSignIn: local && work.status !== "ARCHIVED" ? automaticSignIn : null };
}

export async function cleanCaseIqStaleCredentials(
  userId: string, workId: string, runId: string,
): Promise<CaseIqAuthenticationStatus> {
  await resolveCaseIqSessionOwner(userId, workId, runId);
  return withRunStartLock([`credential-manager:${userId}`], async () => {
    const credentialCleanup = await cleanStaleCopilotCredentials();
    const status = await getCaseIqAuthenticationStatus(userId, workId, runId, true);
    return { ...status, credentialCleanup };
  });
}

const monitors = new Set<string>();
function monitorAuthentication(spec: CaseIqAuthenticationSpec, operation: StoredCaseIqAuthentication) {
  if (monitors.has(operation.id)) return;
  monitors.add(operation.id);
  void (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (!(await caseIqAuthenticationActivity(operation)).reserved) return;
      const accepted = await acceptCaseIqAuthentication(spec, async () => {
        const current = await readCaseIqAuthentication(operation.workId);
        if (current?.id !== operation.id || current.userId !== operation.userId) throw new CaseIqIntegrationError("The authentication owner changed.");
        const { work, run } = await resolveCaseIqSessionOwner(operation.userId, operation.workId, operation.sourceRunId);
        const reason = work.status === "ARCHIVED" ? "The Work was archived during sign-in preparation."
          : await activeCaseIqWorkReason(work.id, spec.sessionId, run.id, work);
        if (reason) throw new CaseIqIntegrationError(reason);
      });
      if (accepted) return;
      await sleep(250);
    }
    throw new CaseIqIntegrationError("CaseIQ authentication preparation is still unconfirmed. Inspect the original window; this Work remains reserved.");
  })().catch(async (error: unknown) => {
    console.error("[CaseIQ] Authentication preparation failed.", error);
    const file = path.join(path.dirname(spec.requestFile), "authentication-error.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ operationId: operation.id, message: error instanceof CaseIqIntegrationError
      ? error.message : "Authentication preparation failed. Inspect the original window and local diagnostics." }), { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  }).catch((error: unknown) => {
    console.error("[CaseIQ] Authentication failure could not be persisted.", error);
  }).finally(() => { monitors.delete(operation.id); });
}

export async function startCaseIqAuthentication(
  userId: string, workId: string, runId: string, requestId: string, trustWorkFolder = false, automatic = false,
): Promise<CaseIqAuthenticationStatus> {
  const owner = await resolveCaseIqSessionOwner(userId, workId, runId);
  const existing = await readCaseIqAuthentication(workId);
  if (existing && existing.userId !== userId) throw new CaseIqIntegrationError("Authentication belongs to another user.", 403);
  if (existing?.id === requestId) {
    if ((!automatic && existing.sourceRunId !== runId) || existing.sessionId !== owner.binding.sessionId ||
        existing.trustWorkFolder !== trustWorkFolder || Boolean(existing.automatic) !== automatic) {
      throw new CaseIqIntegrationError("This authentication request ID belongs to a different Run/session.");
    }
    return getCaseIqAuthenticationStatus(userId, workId, runId, true);
  }
  return withRunStartLock([`work:${workId}`, `session:${owner.binding.sessionId}`], async () => {
    const { work, workingDirectory, run, binding } = await resolveCaseIqSessionOwner(userId, workId, runId);
    if (automatic) {
      const current = await readCaseIqAuthentication(workId);
      if (current && current.userId !== userId) throw new CaseIqIntegrationError("Authentication belongs to another user.", 403);
      const currentConnection = current?.sessionId === binding.sessionId ? await readCaseIqNativeConnection(current, binding.oauthStorage) : null;
      const requirement = await automaticSignInRequirement(userId, workId, binding.sessionId, run, current,
        currentConnection?.status === "connected" ? currentConnection.checkedAt : null);
      if (!requirement || requirement.requestId !== requestId || requirement.attempted) {
        throw new CaseIqIntegrationError("This sign-in requirement is no longer pending or was already handled. Refresh its state.", 409);
      }
    }
    const reason = work.status === "ARCHIVED" ? "Restore this Work before signing in."
      : await activeCaseIqWorkReason(work.id, binding.sessionId, run.id, work);
    if (reason) throw new CaseIqIntegrationError(reason);
    const home = nativeSessionBindingHome(binding);
    if (home === null) throw new CaseIqIntegrationError("The original CaseIQ home is unavailable.");
    if (!await copilotSessionHasHistory(binding.sessionId, home)) throw new CaseIqIntegrationError("The original CaseIQ history is unavailable.");
    try { await assertCopilotSessionNotInUse(binding.sessionId, home); }
    catch (error) {
      if (error instanceof CopilotSessionInUseError) throw new CaseIqIntegrationError("The original CaseIQ session is already open. Exit that session before opening authentication.");
      throw error;
    }
    const spec = await prepareCaseIqAuthentication({
      userId, workId, runId: requestId, sessionId: binding.sessionId, workingDirectory,
      trustWorkFolder,
    });
    await ensurePrivateRuntimeDirectory(caseIqAuthenticationDirectory());
    await writeFile(spec.terminalFile, JSON.stringify({ mode: "authentication", sessionId: binding.sessionId }), {
      flag: "wx", mode: 0o600,
    });
    const operation: StoredCaseIqAuthentication = {
      id: requestId, sessionId: binding.sessionId, sourceRunId: runId, startedAt: new Date().toISOString(),
      userId, workId, hostname: hostname(), launchRejected: false, errorMessage: null,
      trustWorkFolder,
      ...(automatic ? { automatic: true } : {}),
    };
    await writeCaseIqAuthentication(operation);
    try {
      await spawnDetached("wt.exe", [
        "--window", "new", "new-tab", "--startingDirectory", workingDirectory,
        "--title", `SupportIQ sign-in ${work.id.slice(0, 8)}`,
        spec.powerShellExecutable, "-NoLogo", "-NoProfile", "-File", spec.script, ...spec.arguments,
      ], workingDirectory, { ...buildCaseIqEnvironment(), ...spec.environment });
    } catch (error) {
      await writeCaseIqAuthentication({ ...operation, launchRejected: true,
        errorMessage: "The authentication window could not be launched. Check Windows Terminal and the verified PowerShell host." });
      throw error;
    }
    monitorAuthentication(spec, operation);
    const state = await caseIqAuthenticationActivity(operation);
    return { available: false, blockedReason: state.message, authenticationVerified: false, operation: state };
  });
}
