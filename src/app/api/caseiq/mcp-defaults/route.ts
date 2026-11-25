import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { CaseIqIntegrationError } from "@/lib/caseiq-errors";
import { RunStartInProgressError, withRunStartLock } from "@/lib/run-start-lock";
import { ensurePrivateRuntimeDirectory } from "@/lib/caseiq-integration";
import { caseIqMcpDefaultsSchema, caseIqMcpDefaultsStatusSchema } from "@/lib/caseiq-options";
import { caseIqMcpDefaultsDirectory, readCaseIqMcpDefaults, writeCaseIqMcpDefaults } from "@/lib/caseiq-mcp-defaults-state";
import { discoverCaseIqMcpServers } from "@/lib/caseiq-mcp-sessions";
import { cleanStaleCopilotCredentials, inspectWindowsCredentialManager } from "@/lib/windows-credential-manager";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const postSchema = z.object({ action: z.literal("clean-credentials") }).strict();
function local(request: NextRequest) {
  return localTerminalAvailable(request.headers.get("host") ?? request.nextUrl.hostname);
}
async function status(userId: string, request: NextRequest, forceCredentialRefresh = false) {
  const isLocal = local(request);
  const [settings, catalog, credentialManager] = await Promise.all([
    readCaseIqMcpDefaults(userId),
    discoverCaseIqMcpServers(userId),
    isLocal ? inspectWindowsCredentialManager({ forceRefresh: forceCredentialRefresh }).catch(() => null) : Promise.resolve(null),
  ]);
  const knownServers = [...new Set([...catalog.serverNames, ...settings.servers.map((server) => server.serverName)])].sort();
  return caseIqMcpDefaultsStatusSchema.parse({
    settings, knownServers, available: isLocal,
    blockedReason: isLocal ? null : "Configure MCP defaults on the local Windows execution host.",
    warnings: catalog.warnings,
    ...(credentialManager ? { credentialManager } : {}),
  });
}
function failure(error: unknown) {
  if (error instanceof CaseIqIntegrationError || error instanceof RunStartInProgressError) {
    return NextResponse.json({ error: error.message }, { status: error instanceof CaseIqIntegrationError ? error.status : 409, headers });
  }
  console.error("[CaseIQ] MCP defaults request failed.", error);
  return NextResponse.json({ error: "MCP defaults could not be checked or saved. Inspect local diagnostics." }, { status: 500, headers });
}
export async function GET(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try { return NextResponse.json(await status(userId, request), { headers }); }
  catch (error) { return failure(error); }
}
export async function PUT(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const expected = `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  if (!local(request) || request.headers.get("origin") && request.headers.get("origin") !== expected) {
    return NextResponse.json({ error: "Save MCP defaults from this site's local execution host." }, { status: 403, headers });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "MCP defaults require application/json." }, { status: 415, headers });
  }
  const parsed = caseIqMcpDefaultsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid MCP defaults." }, { status: 400, headers });
  try {
    return await withRunStartLock([`mcp-defaults:${userId}`], async () => {
      const current = await status(userId, request);
      if (parsed.data.servers.some((server) => !current.knownServers.includes(server.serverName))) {
        throw new CaseIqIntegrationError("Configure only MCPs discovered in your CaseIQ sessions.", 400);
      }
      await ensurePrivateRuntimeDirectory(caseIqMcpDefaultsDirectory());
      await writeCaseIqMcpDefaults(userId, parsed.data);
      return NextResponse.json(await status(userId, request), { headers });
    });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  const expected = `${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`;
  if (!local(request) || request.headers.get("origin") && request.headers.get("origin") !== expected) {
    return NextResponse.json({ error: "Clean credentials from this site's local execution host." }, { status: 403, headers });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Credential cleanup requires application/json." }, { status: 415, headers });
  }
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid credential cleanup request." }, { status: 400, headers });
  try {
    return await withRunStartLock([`credential-manager:${userId}`], async () => {
      const credentialCleanup = await cleanStaleCopilotCredentials();
      const updated = await status(userId, request, true);
      return NextResponse.json(caseIqMcpDefaultsStatusSchema.parse({ ...updated, credentialCleanup }), { headers });
    });
  } catch (error) { return failure(error); }
}
