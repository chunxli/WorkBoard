import { describe, expect, it } from "vitest";
import { resolveCopilotEntraConfig } from "./copilot-entra";
import { resolveAuthMode } from "./auth-mode";

const clientId = "11111111-2222-3333-4444-555555555555";

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
