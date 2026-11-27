import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EntraAuthConfig } from "@github/copilot-sdk";

const SUPPORT_IQ_NAME_PATTERN = /^support[-_]?iq$/i;
const SUPPORT_IQ_HOST_PATTERN = /^https?:\/\/api\.support\.microsoft\.com(?:\/|$)/i;
const SUPPORT_IQ_PATH_PATTERN = /\/supportiq(?:\/|\?|$)/i;

const TERMINAL_LAUNCH_ENV_KEYS = ["COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] as const;

export interface SupportIqMcpDetectionOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  workingDirectory?: string | null;
  disabledServers?: Iterable<string>;
}

export interface HttpSupportIqServerMatch {
  name: string;
  url: string;
  tools: string[];
  timeout?: number;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing, unreadable, or malformed optional config files must not block CLI launch.
  }
  return null;
}

function resolveCopilotHomeForDetection(
  environment?: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicitHome = environment?.COPILOT_HOME?.trim();
  if (explicitHome) return path.resolve(explicitHome);
  const userHome =
    environment?.USERPROFILE?.trim() ||
    environment?.HOME?.trim() ||
    (environment?.HOMEDRIVE && environment?.HOMEPATH
      ? path.join(environment.HOMEDRIVE, environment.HOMEPATH)
      : "");
  return userHome ? path.join(path.resolve(userHome), ".copilot") : null;
}

function isSupportIqMcpUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  return SUPPORT_IQ_HOST_PATTERN.test(trimmed) || SUPPORT_IQ_PATH_PATTERN.test(trimmed);
}

function collectDisabledMcpServerNames(
  copilotHome: string | null,
  workingDirectory: string | null,
  extraDisabled?: Iterable<string>,
): Set<string> {
  const disabled = new Set<string>();
  if (extraDisabled) {
    for (const item of extraDisabled) {
      const normalized = item.trim().toLowerCase();
      if (normalized) disabled.add(normalized);
    }
  }
  const settingsPaths = [
    copilotHome ? path.join(copilotHome, "settings.json") : null,
    workingDirectory ? path.join(workingDirectory, ".github", "copilot", "settings.json") : null,
    workingDirectory ? path.join(workingDirectory, ".github", "copilot", "settings.local.json") : null,
  ];
  for (const settingsPath of settingsPaths) {
    if (!settingsPath) continue;
    const record = readJsonRecord(settingsPath);
    if (!Array.isArray(record?.disabledMcpServers)) continue;
    for (const entry of record.disabledMcpServers) {
      if (typeof entry !== "string") continue;
      const normalized = entry.trim().toLowerCase();
      if (normalized) disabled.add(normalized);
    }
  }
  return disabled;
}

export function extractDisabledMcpServersFromArgs(args: readonly string[] = []): string[] {
  const disabled: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--disable-mcp-server" && typeof args[index + 1] === "string") {
      disabled.push(args[index + 1]);
      index += 1;
    } else if (arg.startsWith("--disable-mcp-server=")) {
      disabled.push(arg.slice("--disable-mcp-server=".length));
    }
  }
  return disabled;
}

/**
 * Finds any enabled HTTP/SSE SupportIQ MCP entries in ordinary Copilot CLI config.
 * Entries already using `"type": "local"` / `"stdio"` (such as `supportiq-mcp-bridge.mjs`)
 * are ignored because they already bypass Copilot CLI's shared Credential Manager OAuth slot.
 */
export function findHttpSupportIqMcpServers(
  options: SupportIqMcpDetectionOptions = {},
): HttpSupportIqServerMatch[] {
  const copilotHome = resolveCopilotHomeForDetection(options.environment);
  const workingDirectory = options.workingDirectory?.trim()
    ? path.resolve(options.workingDirectory.trim())
    : null;
  if (!copilotHome && !workingDirectory) return [];

  const disabledNames = collectDisabledMcpServerNames(
    copilotHome,
    workingDirectory,
    options.disabledServers,
  );
  const mcpConfigPaths = [
    copilotHome ? path.join(copilotHome, "mcp-config.json") : null,
    workingDirectory ? path.join(workingDirectory, ".mcp.json") : null,
    workingDirectory ? path.join(workingDirectory, ".vscode", "mcp.json") : null,
    workingDirectory ? path.join(workingDirectory, ".github", "copilot", "mcp-config.json") : null,
  ];

  const byName = new Map<string, HttpSupportIqServerMatch>();
  for (const configPath of mcpConfigPaths) {
    if (!configPath) continue;
    const record = readJsonRecord(configPath);
    if (!record) continue;
    for (const sectionKey of ["mcpServers", "servers"] as const) {
      const section = record[sectionKey];
      if (!section || typeof section !== "object" || Array.isArray(section)) continue;
      for (const [rawName, rawEntry] of Object.entries(section as Record<string, unknown>)) {
        const name = rawName.trim();
        if (!name || disabledNames.has(name.toLowerCase())) continue;
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
        const entry = rawEntry as {
          type?: unknown;
          disabled?: unknown;
          enabled?: unknown;
          url?: unknown;
          tools?: unknown;
          timeout?: unknown;
        };
        if (entry.disabled === true || entry.enabled === false) {
          byName.delete(name);
          continue;
        }
        const type = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";
        if (type === "local" || type === "stdio") {
          byName.delete(name);
          continue;
        }
        const url = typeof entry.url === "string" ? entry.url.trim() : "";
        if (!url || (!SUPPORT_IQ_NAME_PATTERN.test(name) && !isSupportIqMcpUrl(url))) {
          continue;
        }
        const tools =
          Array.isArray(entry.tools) && entry.tools.every((item) => typeof item === "string")
            ? (entry.tools as string[])
            : ["*"];
        const timeout =
          typeof entry.timeout === "number" && Number.isFinite(entry.timeout) && entry.timeout > 0
            ? entry.timeout
            : undefined;
        byName.set(name, { name, url, tools, ...(timeout ? { timeout } : {}) });
      }
    }
  }
  return [...byName.values()];
}

/**
 * Builds `--additional-mcp-config <json>` CLI arguments that transparently replace any
 * direct HTTP SupportIQ MCP server in ordinary Copilot CLI with WorkBoard's Windows WAM
 * TSE stdio bridge (`scripts/supportiq-mcp-bridge.mjs`), keeping OneAuth active for
 * corporate `@microsoft.com` MCP servers while preventing Credential Manager collisions
 * with CaseIQ.
 */
export function resolveSupportIqCliBridgeArgs(
  options: SupportIqMcpDetectionOptions & {
    platform?: NodeJS.Platform;
    bridgeScriptPath?: string;
    nodeExecutable?: string;
    interactiveAuth?: boolean;
  } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return [];
  const matches = findHttpSupportIqMcpServers(options);
  if (matches.length === 0) return [];

  const bridgeScript =
    options.bridgeScriptPath ?? path.join(/* turbopackIgnore: true */ process.cwd(), "scripts", "supportiq-mcp-bridge.mjs");
  if (!existsSync(bridgeScript)) return [];
  const nodeExecutable = options.nodeExecutable ?? process.execPath;

  const mcpServers: Record<string, unknown> = {};
  for (const match of matches) {
    const serverEnv: Record<string, string> = {};
    if (match.url !== "https://api.support.microsoft.com/v2/supportiq/mcp") {
      serverEnv.SUPPORTIQ_MCP_URL = match.url;
    }
    if (options.interactiveAuth) {
      serverEnv.SUPPORTIQ_INTERACTIVE_AUTH = "1";
    }
    mcpServers[match.name] = {
      type: "local",
      command: nodeExecutable,
      args: [bridgeScript],
      tools: match.tools,
      timeout: match.timeout ?? 120_000,
      ...(Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {}),
    };
  }
  return ["--additional-mcp-config", JSON.stringify({ mcpServers })];
}

/**
 * Extracts non-secret launcher environment settings to persist in a Windows Terminal
 * launch manifest so an already-running `WindowsTerminal.exe` server still applies
 * them inside `workboard-resume.ps1` before invoking `copilot`.
 */
export function buildTerminalLaunchEnvironmentOverrides(
  environment: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};
  for (const key of TERMINAL_LAUNCH_ENV_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0) {
      overrides[key] = value;
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

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
