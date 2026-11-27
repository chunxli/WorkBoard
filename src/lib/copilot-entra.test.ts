import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTerminalLaunchEnvironmentOverrides,
  extractDisabledMcpServersFromArgs,
  findHttpSupportIqMcpServers,
  resolveCopilotEntraConfig,
  resolveSupportIqCliBridgeArgs,
} from "./copilot-entra";
import { resolveAuthMode } from "./auth-mode";

const clientId = "11111111-2222-3333-4444-555555555555";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Copilot host Entra registration", () => {
  it("uses only the explicitly configured host application ID", () => {
    expect(resolveCopilotEntraConfig({
      WORKBOARD_COPILOT_ENTRA_CLIENT_ID: ` ${clientId} `,
      AUTH_MICROSOFT_ENTRA_ID_ID: "different-web-login-application",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "synthetic-web-secret",
      GH_TOKEN: "synthetic-github-token",
    })).toEqual({ clientId });
  });

  it("does not borrow the website's registration or require Entra for unrelated authentication", () => {
    expect(resolveCopilotEntraConfig({})).toBeUndefined();
    expect(resolveCopilotEntraConfig({ WORKBOARD_COPILOT_ENTRA_CLIENT_ID: "  " })).toBeUndefined();
    expect(resolveCopilotEntraConfig({ AUTH_MICROSOFT_ENTRA_ID_ID: clientId })).toBeUndefined();
  });

  it("allows MCP company-account authentication without changing website login mode", () => {
    const environment = {
      WORKBOARD_COPILOT_ENTRA_CLIENT_ID: clientId,
      AUTH_MICROSOFT_ENTRA_ID_ID: "",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "",
    };
    expect(resolveAuthMode(environment)).toBe("local");
    expect(resolveCopilotEntraConfig(environment)).toEqual({ clientId });
  });

  it.each(["invalid-id", "https://example.com", "synthetic-secret", `${clientId}\nsecond-value`])("rejects malformed configuration without leaking its value (%s)", (value) => {
    expect(() => resolveCopilotEntraConfig({ WORKBOARD_COPILOT_ENTRA_CLIENT_ID: value }))
      .toThrow("WORKBOARD_COPILOT_ENTRA_CLIENT_ID must be");
    expect(() => resolveCopilotEntraConfig({ WORKBOARD_COPILOT_ENTRA_CLIENT_ID: value })).not.toThrow(value);
  });
});

describe("SupportIQ HTTP-to-WAM-bridge CLI override", () => {
  it("leaves CLI arguments untouched when SupportIQ is absent or already configured as a local stdio bridge", async () => {
    const copilotHome = await mkdtemp(path.join(os.tmpdir(), "workboard-entra-local-siq-"));
    const bridgeScript = path.join(copilotHome, "supportiq-mcp-bridge.mjs");
    tempDirs.push(copilotHome);
    await writeFile(bridgeScript, "// stub bridge\n", "utf8");
    await writeFile(
      path.join(copilotHome, "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          workiq: { type: "http", url: "https://workiq.svc.cloud.microsoft/mcp" },
          SupportIQ: {
            type: "local",
            command: "node",
            args: [bridgeScript],
            tools: ["case_get"],
          },
        },
      }),
      "utf8",
    );

    expect(findHttpSupportIqMcpServers({ environment: { COPILOT_HOME: copilotHome } })).toEqual([]);
    expect(
      resolveSupportIqCliBridgeArgs({
        environment: { COPILOT_HOME: copilotHome },
        platform: "win32",
        bridgeScriptPath: bridgeScript,
      }),
    ).toEqual([]);
  });

  it("replaces HTTP SupportIQ entries with the local WAM TSE stdio bridge while preserving tool allowlists", async () => {
    const copilotHome = await mkdtemp(path.join(os.tmpdir(), "workboard-entra-http-siq-"));
    const bridgeScript = path.join(copilotHome, "supportiq-mcp-bridge.mjs");
    tempDirs.push(copilotHome);
    await writeFile(bridgeScript, "// stub bridge\n", "utf8");
    await writeFile(
      path.join(copilotHome, "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          SupportIQ: {
            type: "http",
            url: "https://api.support.microsoft.com/v2/supportiq/mcp",
            tools: ["case_get", "scope_resolve"],
          },
        },
      }),
      "utf8",
    );

    const args = resolveSupportIqCliBridgeArgs({
      environment: { COPILOT_HOME: copilotHome },
      platform: "win32",
      bridgeScriptPath: bridgeScript,
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(args[0]).toBe("--additional-mcp-config");
    const parsed = JSON.parse(args[1]) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers.SupportIQ).toEqual({
      type: "local",
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [bridgeScript],
      tools: ["case_get", "scope_resolve"],
      timeout: 120_000,
    });

    // Respects settings.json disabledMcpServers and CLI --disable-mcp-server flags.
    await writeFile(
      path.join(copilotHome, "settings.json"),
      JSON.stringify({ disabledMcpServers: ["supportiq"] }),
      "utf8",
    );
    expect(
      resolveSupportIqCliBridgeArgs({
        environment: { COPILOT_HOME: copilotHome },
        platform: "win32",
        bridgeScriptPath: bridgeScript,
      }),
    ).toEqual([]);

    await writeFile(path.join(copilotHome, "settings.json"), JSON.stringify({}), "utf8");
    expect(
      resolveSupportIqCliBridgeArgs({
        environment: { COPILOT_HOME: copilotHome },
        disabledServers: extractDisabledMcpServersFromArgs(["--disable-mcp-server", "SupportIQ"]),
        platform: "win32",
        bridgeScriptPath: bridgeScript,
      }),
    ).toEqual([]);
  });

  it("persists only non-secret launcher overrides for Windows Terminal manifests", () => {
    expect(
      buildTerminalLaunchEnvironmentOverrides({
        NODE_ENV: "production",
        GH_TOKEN: "secret-gh-token",
        GITHUB_TOKEN: "secret-github-token",
        COPILOT_GITHUB_TOKEN: "secret-copilot-token",
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "C:\\paired\\instructions",
      }),
    ).toEqual({
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "C:\\paired\\instructions",
    });
  });
});
