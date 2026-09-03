export function resolveRuntimeAuthMode(environment = process.env) {
  const clientId = environment.AUTH_MICROSOFT_ENTRA_ID_ID?.trim() ?? "";
  const clientSecret = environment.AUTH_MICROSOFT_ENTRA_ID_SECRET?.trim() ?? "";
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "Set both AUTH_MICROSOFT_ENTRA_ID_ID and AUTH_MICROSOFT_ENTRA_ID_SECRET, or leave both empty for local mode.",
    );
  }
  return clientId ? "entra" : "local";
}

export function nextHostnameArgs(environment = process.env) {
  return resolveRuntimeAuthMode(environment) === "local"
    ? ["-H", "127.0.0.1"]
    : [];
}
