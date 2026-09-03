import { handlers } from "@/auth";
import { authMode } from "@/lib/auth-mode";

function localAuthDisabled() {
	return new Response("Authentication is disabled in local mode", { status: 404 });
}

export const GET = authMode === "local" ? localAuthDisabled : handlers.GET;
export const POST = authMode === "local" ? localAuthDisabled : handlers.POST;

