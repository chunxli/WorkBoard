import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CaseIqSignInProgress from "./CaseIqSignInProgress";
import type { CaseIqAuthenticationOperation, CaseIqAuthenticationStatus } from "@/lib/caseiq-options";

const sessionId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const at = "2026-11-11T00:00:00.000Z";
function status(operation: Partial<CaseIqAuthenticationOperation> | null = {}, overrides: Partial<CaseIqAuthenticationStatus> = {}): CaseIqAuthenticationStatus {
  return {
    sessionId, available: false, blockedReason: "Sign-in in progress.", authenticationVerified: false,
    operation: operation === null ? null : {
      id: operationId, sessionId, sourceRunId: "run", startedAt: at, status: "active",
      reserved: true, message: "Synthetic original Session.", phase: "preparing", trustWorkFolder: true, ...operation,
    }, ...overrides,
  };
}
function render(value: CaseIqAuthenticationStatus | null, overrides: Partial<Parameters<typeof CaseIqSignInProgress>[0]> = {}) {
  return renderToStaticMarkup(<CaseIqSignInProgress status={value} opening={false} uncertain={false}
    error={null} commandCopied={false} clipboardError={null} {...overrides} />);
}
describe("truthful guided SupportIQ sign-in", () => {
  it("highlights the current Next action and renders the exact command as a separate code block", () => {
    const markup = render(status({ phase: "native-started" }));
    expect(markup).toContain('class="caseiq-signin-next break-words"');
    expect(markup).toContain('<code class="caseiq-signin-command">/mcp auth SupportIQ</code>');
    expect(markup).toContain('aria-label="Next sign-in action"');
  });
  it("keeps actionable compact guidance visible while the top disclosure is collapsed", () => {
    const markup = render(status({ phase: "native-started" }), { compact: true });
    expect(markup).toContain('aria-label="SupportIQ sign-in action"');
    expect(markup).toContain("caseiq-signin-callout");
    expect(markup).toContain("<strong>TSE account</strong>");
    expect(markup).toContain("<strong>exit Copilot</strong>");
    expect(markup).toContain("No task prompts.");
    expect(markup.match(/data-state="complete"/g)).toHaveLength(3);
    expect(markup).not.toContain("<details");
  });
  it("does not render a permanent compact card after successful sign-in or for unknown idle state", () => {
    expect(render(status(null, { available: true }), { compact: true })).toBe("");
    expect(render(status({ status: "closed", reserved: false }, {
      available: true, authenticationVerified: true, connection: { status: "connected", toolCount: 10, checkedAt: at },
    }), { compact: true })).toBe("");
  });
  it("does not tell the user to type a command before native preparation finishes", () => {
    const markup = render(status(), { compact: true });
    expect(markup).toContain("Wait for CaseIQ to finish preparation");
    expect(markup).not.toContain('class="caseiq-signin-command"');
  });
  it("guides a confirmed authentication requirement even without a previous login operation", () => {
    const markup = render(status(null, { available: true,
      connection: { status: "needs-auth", toolCount: null, checkedAt: at } }), { compact: true });
    expect(markup).toContain("SupportIQ sign-in is required");
    expect(markup).toContain("caseiq-signin-command");
    expect(markup).not.toContain('data-state="complete"');
    expect(markup).not.toContain("animate-spin");
  });

  it("does not invent a running sign-in flow for unknown idle state", () => {
    expect(render(status(null, { available: true }))).toBe("");
  });
  it("waits for the Work instead of suggesting another window or a repeated task", () => {
    const markup = render(status({ reserved: false, status: "closed" }, {
      automaticSignIn: { requestId: "00000000-0000-4000-8000-000000000003", requiredAt: at, attempted: false },
    }));
    expect(markup).toContain("Waiting for this Work");
    expect(markup).toContain("will open automatically");
    expect(markup).not.toContain('data-state="complete"');
    expect(markup).toContain("no failed Prompt will be replayed");
  });
  it("shows a real request and preparation without declaring that the native process has started", () => {
    const markup = render(status());
    expect(markup).toContain("Preparing the original CaseIQ Session");
    expect(markup.match(/data-state="complete"/g)).toHaveLength(1);
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).not.toContain("Only this Work&#x27;s exact folder was trusted");
  });
  it("guides the manual command and official TSE login after a proven native start", () => {
    const markup = render(status({ phase: "native-started" }), { commandCopied: true });
    expect(markup).toContain("Waiting for TSE sign-in and native OAuth verification");
    expect(markup).toContain("paste /mcp auth SupportIQ");
    expect(markup).toContain("official TSE sign-in");
    expect(markup).toContain("Only this Work&#x27;s exact folder was trusted");
    expect(markup.match(/data-state="complete"/g)).toHaveLength(3);
    expect(markup).toContain('aria-current="step"');
  });
  it("offers a clipboard fallback without pretending a command was copied or auto-executed", () => {
    const markup = render(status({ phase: "native-started" }), { clipboardError: "Not focused." });
    expect(markup).toContain("type /mcp auth SupportIQ");
    expect(markup).toContain("Clipboard unavailable");
    expect(markup).not.toContain("Authentication command copied");
  });
  it("asks the user to close the Terminal after OAuth checks, rather than automatically killing it", () => {
    const markup = render(status({ phase: "native-started" }, {
      authenticationVerified: true, connection: { status: "connected", toolCount: 10, checkedAt: at },
    }));
    expect(markup).toContain("waiting for the Terminal to close");
    expect(markup).toContain("Exit Copilot and close");
    expect(markup.match(/data-state="complete"/g)).toHaveLength(4);
  });
  it("completes only after checked OAuth and released reservation, with an explicit next action", () => {
    const markup = render(status({ status: "closed", reserved: false }, {
      available: true, authenticationVerified: true, connection: { status: "connected", toolCount: 10, checkedAt: at },
    }));
    expect(markup).toContain("Native OAuth check completed");
    expect(markup).toContain("Send a new Follow Up");
    expect(markup.match(/data-state="complete"/g)).toHaveLength(5);
    expect(markup).not.toContain("animate-spin");
  });
  it("never treats a closed window or acceptance uncertainty as verified sign-in", () => {
    const closed = render(status({ status: "closed", reserved: false }));
    expect(closed).toContain("OAuth remains unverified");
    expect(closed).not.toContain("Native OAuth check completed");
    const uncertain = render(status(), { uncertain: true });
    expect(uncertain).toContain("unconfirmed");
    expect(uncertain).toContain("Do not open another window");
    expect(uncertain).not.toContain("animate-spin");
  });
  it("does not show another Session's open window as this Session being prepared", () => {
    const markup = render(status({ sessionId: "00000000-0000-4000-8000-000000000004" }));
    expect(markup).toContain("Another Session of this Work");
    expect(markup).toContain("will not replace its Session");
    expect(markup).not.toContain('data-state="complete"');
  });
});
