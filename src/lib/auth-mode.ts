export type WorkBoardAuthMode = "entra" | "local";

interface AuthEnvironment {
  AUTH_MICROSOFT_ENTRA_ID_ID?: string;
  AUTH_MICROSOFT_ENTRA_ID_SECRET?: string;
}

export function resolveAuthMode(
  environment: AuthEnvironment = process.env as AuthEnvironment
): WorkBoardAuthMode {
  const clientId = environment.AUTH_MICROSOFT_ENTRA_ID_ID?.trim() ?? "";
  const clientSecret = environment.AUTH_MICROSOFT_ENTRA_ID_SECRET?.trim() ?? "";

  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "Set both AUTH_MICROSOFT_ENTRA_ID_ID and AUTH_MICROSOFT_ENTRA_ID_SECRET, or leave both empty for local mode."
    );
  }
  return clientId ? "entra" : "local";
}

export const authMode = resolveAuthMode();

export function isLoopbackHostname(host: string | null | undefined): boolean {
  const value = host?.trim().toLowerCase();
  if (!value) return false;
  if (value === "::1") return true;

  try {
    const hostname = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "localhost." || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}