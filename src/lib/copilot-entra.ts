import type { EntraAuthConfig } from "@github/copilot-sdk";

export function resolveCopilotEntraConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EntraAuthConfig | undefined {
  const clientId = environment.WORKBOARD_COPILOT_ENTRA_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(clientId)) {
    throw new Error("WORKBOARD_COPILOT_ENTRA_CLIENT_ID must be the Application (client) ID of Work Board's own Microsoft Entra public-client registration.");
  }
  return { clientId };
}
