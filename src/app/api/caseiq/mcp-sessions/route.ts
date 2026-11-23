import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { listCaseIqMcpSessions } from "@/lib/caseiq-mcp-sessions";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try { return NextResponse.json(await listCaseIqMcpSessions(userId), { headers }); }
  catch (error) {
    console.error("[CaseIQ] MCP session index failed.", error);
    return NextResponse.json({ error: "MCP Work/session configuration could not be loaded. Inspect local diagnostics." }, { status: 500, headers });
  }
}
