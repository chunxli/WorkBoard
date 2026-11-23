import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseIqAuthenticationPanel, CaseIqSignInCallout } from "./CaseIqAuthenticationPanel";
import { isCaseIqAuthenticationCommand, type CaseIqAuthenticationStatus } from "@/lib/caseiq-options";
import type { useCaseIqAuthentication } from "./CaseIqAuthenticationPanel";

function control(status: CaseIqAuthenticationStatus, checking = false, checkedAt: string | null = null,
  overrides: Partial<ReturnType<typeof useCaseIqAuthentication>> = {}) {
  const authentication: ReturnType<typeof useCaseIqAuthentication> = {
    status, error: null, opening: false, uncertain: false, reserved: status.operation?.reserved ?? false,
    refresh: vi.fn(), refreshManually: vi.fn(), start: vi.fn(), reportError: vi.fn(), checking, checkedAt,
    trustWorkFolder: true, setTrustWorkFolder: vi.fn(), commandCopied: false, clipboardError: null, copyCommand: vi.fn(),
    ...overrides,
  };
  return authentication;
}
function render(...args: Parameters<typeof control>) {
  return renderToStaticMarkup(<CaseIqAuthenticationPanel authentication={control(...args)} />);
}
function callout(status: CaseIqAuthenticationStatus, overrides: Partial<ReturnType<typeof useCaseIqAuthentication>> = {}) {
  return renderToStaticMarkup(<CaseIqSignInCallout authentication={control(status, false, null, overrides)} />);
}
describe("visible manual SupportIQ sign-in", () => {
  it("provides direct manual actions and an explicit exact-folder trust choice at the composer", () => {
    const markup = callout({ available: true, blockedReason: null, authenticationVerified: false, operation: null,
      connection: { status: "needs-auth", toolCount: null, checkedAt: null } }, { trustWorkFolder: false });
    expect(markup).toContain('aria-label="SupportIQ sign-in action"');
    expect(markup).toContain("Sign in to SupportIQ");
    expect(markup).toContain("Copy authentication command");
    expect(markup).toContain("Refresh sign-in state");
    expect(markup).toContain("Trust this Work");
    expect(markup).not.toContain('checked=""');
    expect(markup).not.toContain('type="submit"');
  });
  it("highlights closing the already-verified Terminal rather than suggesting another login", () => {
    const markup = callout({ available: false, blockedReason: "Exit Copilot.", authenticationVerified: true,
      connection: { status: "connected", toolCount: 10, checkedAt: new Date().toISOString() },
      operation: { id: "operation", sessionId: "session", sourceRunId: "run", startedAt: new Date().toISOString(),
        status: "active", reserved: true, phase: "native-started", message: "Exit Copilot." } });
    expect(markup).toContain("waiting for the Terminal to close");
    expect(markup).toContain("Exit Copilot and close");
    expect(markup).toContain("Refresh sign-in state");
    expect(markup).not.toContain("caseiq-signin-command");
    expect(markup).not.toContain("Copy authentication command");
    expect(markup).not.toContain(">Sign in to SupportIQ<");
  });
  it("does not leave an idle composer notice for unknown or successfully released Sessions", () => {
    expect(callout({ available: true, blockedReason: null, authenticationVerified: false, operation: null })).toBe("");
    expect(callout({ available: true, blockedReason: null, authenticationVerified: true, operation: null,
      connection: { status: "connected", toolCount: 10, checkedAt: new Date().toISOString() } })).toBe("");
  });
  it("does not offer this Session's command or a competing window while another Session is reserved", () => {
    const markup = callout({ sessionId: "selected-session", available: false, blockedReason: "Another Session is signing in.",
      authenticationVerified: false, operation: { id: "operation", sessionId: "another-session", sourceRunId: "run",
        startedAt: new Date().toISOString(), status: "active", reserved: true, phase: "native-started", message: "Another Session." } });
    expect(markup).toContain("Another Session of this Work");
    expect(markup).not.toContain("Copy authentication command");
    expect(markup).not.toContain("caseiq-signin-command");
    expect(markup).not.toContain(">Sign in to SupportIQ<");
  });
  it("keeps a copied-command failure visible in the compact notice without suggesting it was executed", () => {
    const markup = callout({ available: true, blockedReason: null, authenticationVerified: false, operation: null,
      connection: { status: "needs-auth", toolCount: null, checkedAt: null } }, { clipboardError: "Permission denied." });
    expect(markup).toContain("Clipboard unavailable");
    expect(markup).toContain("Permission denied.");
    expect(markup).not.toContain("Authentication command copied");
  });

  it("describes shared OAuth scope without claiming login success, shared history or tool approval", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false, operation: null,
      oauthStorage: { mode: "shared", reason: null } });
    expect(markup).toContain("Shared OAuth cache prepared");
    expect(markup).toContain("one initial TSE sign-in");
    expect(markup).toContain("Other CaseIQ MCP OAuth sign-ins");
    expect(markup).toContain("Changing the TSE account affects other Sessions");
    expect(markup).toContain("History and tool approvals remain separate");
    expect(markup).not.toContain('data-tone="verified"');
  });
  it("shows a clear nonblocking Session-local fallback instead of claiming sharing succeeded", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false, operation: null,
      oauthStorage: { mode: "session", reason: "local-cache-preserved" } });
    expect(markup).toContain("Shared OAuth is unavailable (local-cache-preserved)");
    expect(markup).toContain("sign in for this Session");
    expect(markup).toContain("role=\"alert\"");
    expect(markup).not.toContain("Shared OAuth cache prepared");
  });
  it("explains that visible tools and an earlier connection do not prove current OAuth sign-in", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false, operation: null,
      connection: { status: "needs-auth", toolCount: null, checkedAt: new Date().toISOString() } });
    expect(markup).toContain("Sign-in required");
    expect(markup).toContain("not proof of a usable OAuth sign-in");
    expect(markup).not.toContain("Previously verified");
    expect(markup).not.toContain('data-tone="verified"');
  });

  it("shows a dedicated native sign-in action, TSE account guidance and honest completion boundaries", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false, operation: null });
    expect(markup).toContain("Sign in to SupportIQ");
    expect(markup).toContain("/mcp auth SupportIQ");
    expect(markup).toContain("TSE account");
    expect(markup).toContain("not a request to the model");
    expect(markup).toContain("No automatic window closing or Full access upgrade");
    expect(markup).toContain("Sign-in help");
    expect(markup).toContain("Trust this Work");
    expect(markup).toContain('checked=""');
  });
  it("keeps an explicit exact-folder trust opt-out available without changing the authentication command", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false, operation: null },
      false, null, { trustWorkFolder: false });
    expect(markup).not.toContain('checked=""');
    expect(markup).toContain("/mcp auth SupportIQ");
    expect(markup).toContain("No parent/global folder trust or Full access");
  });
  it("does not enable another window when the current Work is busy", () => {
    const markup = render({ available: false, blockedReason: "Wait for this Run.", authenticationVerified: false, operation: null });
    expect(markup).toContain("disabled");
    expect(markup).toContain("Wait for this Run.");
  });
  it("labels preparation and unconfirmed stop honestly in the compact summary", () => {
    const operation = { id: "operation", sessionId: "session", sourceRunId: "run", startedAt: new Date().toISOString(),
      status: "opening" as const, reserved: true, message: "Preparing original Session." };
    const preparing = render({ available: false, blockedReason: operation.message, authenticationVerified: false, operation });
    expect(preparing).toContain("Preparing Session");
    expect(preparing).not.toContain('title="Window open"');
    const unconfirmed = render({ available: false, blockedReason: "Stop unconfirmed.", authenticationVerified: false,
      operation: { ...operation, status: "unconfirmed", message: "Stop unconfirmed." } });
    expect(unconfirmed).toContain("Needs attention");
    expect(unconfirmed).toContain("Stop unconfirmed.");
  });
  it("shows manual refresh progress and a completed check without claiming permission upgrades", () => {
    const status = { available: true, blockedReason: null, authenticationVerified: false as const, operation: null };
    expect(render(status, true)).toContain("Checking sign-in state...");
    const checked = render(status, false, "2026-11-10T05:20:00.000Z");
    expect(checked).toContain('dateTime="2026-11-10T05:20:00.000Z"');
    expect(checked).toContain("Sign-in state checked at");
    expect(checked).toContain("window exit alone is not authorization");
  });
  it("keeps historical verification in a collapsed banner with actions inside its disclosure", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: true, operation: null,
      connection: { status: "connected", toolCount: 10, checkedAt: new Date().toISOString() } });
    expect(markup).toContain("OAuth checked");
    expect(markup).toContain("10 tools discovered");
    expect(markup).toContain('<details data-runtime-banner="">');
    expect(markup).not.toContain('<details data-runtime-banner="" open');
    expect(markup).toContain("Sign in to SupportIQ");
    expect(markup).not.toContain("ui-secondary-button");
    expect(markup).toContain("OAuth checked at");
    expect(markup).toContain("dateTime=");
    expect(markup).toContain("not an active MCP connection");
  });
  it("shows explicit copy failure with a manual command fallback, not copied success", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false, operation: null },
      false, null, { clipboardError: "Clipboard denied." });
    expect(markup).toContain("Clipboard denied.");
    expect(markup).toContain("You can type /mcp auth SupportIQ manually.");
    expect(markup).toContain("Copy authentication command");
    expect(markup).not.toContain("The authentication command is on the clipboard");
  });
  it("does not show green verification from a connected field without verified authorization", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false, operation: null,
      connection: { status: "connected", toolCount: 10, checkedAt: new Date().toISOString() } });
    expect(markup).not.toContain("SupportIQ sign-in verified");
  });
  it("keeps a native authentication failure visible even when its sign-in options are compacted", () => {
    const markup = render({ available: true, blockedReason: null, authenticationVerified: false,
      operation: { id: "operation", sessionId: "session", sourceRunId: "run", startedAt: new Date().toISOString(),
        status: "failed", reserved: false, message: "The authentication window ended with an error." } });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The authentication window ended with an error.");
    expect(markup).toContain("Needs attention");
    expect(markup).toContain('<details data-runtime-banner="">');
  });
  it("keeps a stale available result from enabling sign-in while checking or after a refresh failure", () => {
    const status = { available: true, blockedReason: null, authenticationVerified: false, operation: null };
    expect(render(status, true)).toContain("disabled");
    const failed = render(status, false, "2026-11-10T01:32:00.000Z", { error: "Sign-in state unavailable." });
    expect(failed).toContain("Sign-in state unavailable.");
    expect(failed).toContain("disabled");
    expect(failed).not.toContain("Sign-in state checked at");
  });
  it.each(["/mcp auth SupportIQ", " /mcp auth supportiq ", "/MCP AUTH SupportIQ"])("recognizes only an explicit local auth command: %s", (command) => {
    expect(isCaseIqAuthenticationCommand(command)).toBe(true);
  });
  it.each(["Please run /mcp auth SupportIQ", "/mcp auth other", "/mcp auth SupportIQ --allow-all", "/mcp auth SupportIQ\nrun a task"])("does not reinterpret another prompt: %s", (command) => {
    expect(isCaseIqAuthenticationCommand(command)).toBe(false);
  });
});
