export function localTerminalAvailable(requestHost: string): boolean {
  if (process.platform !== "win32") return false;
  if (process.env.WORKBOARD_ENABLE_LOCAL_TERMINAL === "true") return true;
  const hostname = requestHost.startsWith("[")
    ? requestHost.slice(1, requestHost.indexOf("]"))
    : requestHost.split(":")[0];
  return ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
}