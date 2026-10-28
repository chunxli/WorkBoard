import { NextRequest, NextResponse } from "next/server";
import { getCopilotModelCatalog } from "@/lib/copilot-models";
import { getSessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });

  const catalog = await getCopilotModelCatalog(request.nextUrl.searchParams.get("refresh") === "1");
  return NextResponse.json(catalog, { status: catalog.verified ? 200 : 503, headers });
}
