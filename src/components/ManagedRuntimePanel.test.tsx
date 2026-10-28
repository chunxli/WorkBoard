import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ManagedRuntimePanel, { RuntimeInteractionCard, RuntimeMcpServerRow } from "./ManagedRuntimePanel";
import type { RuntimeInteraction } from "@/lib/managed-runtime-types";

const render = (request: RuntimeInteraction, busy = false) => renderToStaticMarkup(<RuntimeInteractionCard request={request} busy={busy} onReply={vi.fn()} />);
describe("live runtime controls", () => {
  it("does not offer generic sign-in for connected builtin GitHub MCP but retains Verify tools", () => {
    const markup = renderToStaticMarkup(<RuntimeMcpServerRow server={{ name: "github-mcp-server", status: "connected", authentication: "copilot-account" }} busy={false} onAction={vi.fn()} />);
    expect(markup).toContain("Verify tools");
    expect(markup).toContain("Uses Copilot account");
    expect(markup).not.toContain(">Sign in</button>");
  });

  it.each(["connected", "failed", "connecting", "disabled", "policy-filtered"])("does not expose OAuth sign-in for %s servers", (status) => {
    const markup = renderToStaticMarkup(<RuntimeMcpServerRow server={{ name: "fixture", status, authentication: "none" }} busy={false} onAction={vi.fn()} />);
    expect(markup).not.toContain(">Sign in</button>");
  });

  it("offers OAuth only for third-party servers explicitly waiting for authentication", () => {
    const markup = renderToStaticMarkup(<RuntimeMcpServerRow server={{ name: "fixture-oauth", status: "needs-auth", authentication: "oauth" }} busy={false} onAction={vi.fn()} />);
    expect(markup).toContain(">Sign in</button>");
    const builtin = renderToStaticMarkup(<RuntimeMcpServerRow server={{ name: "builtin-auth", status: "needs-auth", authentication: "copilot-account" }} busy={false} onAction={vi.fn()} />);
    expect(builtin).not.toContain(">Sign in</button>");
  });
  it.each(["terminal", "entra-host-required"] as const)("guides %s authentication without requesting registration, collecting credentials or replaying a task", (authentication) => {
    const markup = renderToStaticMarkup(<RuntimeMcpServerRow server={{
      name: "fixture-entra", status: "needs-auth", authentication,
    }} busy={false} onAction={vi.fn()} />);
    expect(markup).toContain("Authenticate in Terminal</summary>");
    expect(markup).toContain("Terminal authentication required");
    expect(markup).toContain("<code>copilot</code>");
    expect(markup).toContain("<code>/mcp</code>");
    expect(markup).toContain("fixture-entra");
    expect(markup).toContain("company account");
    expect(markup).toContain("Confirm the connection in Terminal");
    expect(markup).toContain("Reload native MCP");
    expect(markup).toContain("Verify tools");
    expect(markup).toContain("may not be reusable");
    expect(markup).toContain("App access has not been confirmed");
    expect(markup).toContain("No App registration");
    expect(markup).toContain("do not need to replay or resume");
    expect(markup).not.toContain("WORKBOARD_COPILOT_ENTRA_CLIENT_ID");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain(">Sign in</button>");
  });
  it("provides explicit one-time approvals and managed-policy notices without offering allow-all escalation", () => {
    const markup = render({ id: "request", kind: "permission", title: "Allow read?", detail: "C:\\synthetic", managed: true });
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Deny");
    expect(markup).toContain("Organization-managed");
    expect(markup).not.toContain("Allow all");
    expect(render({ id: "request", kind: "permission", title: "Allow?", detail: "fixture", managed: false }, true)).toContain("disabled");
  });

  it("supports agent choices, freeform answers and safe escaped content", () => {
    const markup = render({ id: "question", kind: "question", question: "<script>unsafe</script>", choices: ["A", "B"], allowFreeform: true });
    expect(markup).toContain('type="radio"');
    expect(markup).toContain("<textarea");
    expect(markup).toContain("Send response");
    expect(markup).not.toContain("<script>");
    expect(render({ id: "question", kind: "question", question: "Choose", choices: ["A"], allowFreeform: false })).not.toContain("<textarea");
  });

  it("renders native structured fields, defaults, required constraints and explicit decline/cancel", () => {
    const markup = render({
      id: "form", kind: "form", message: "Fill in", schema: { type: "object", required: ["text"], properties: {
        text: { type: "string", title: "Text", minLength: 2, default: "default" },
        number: { type: "integer", minimum: 1, maximum: 3 },
        boolean: { type: "boolean", default: true },
        choice: { type: "string", enum: ["A"], enumNames: ["Choice A"] },
        many: { type: "array", items: { anyOf: [{ const: "B", title: "Choice B" }] } },
      } },
    });
    expect(markup).toContain('value="default"');
    expect(markup).toContain('type="number"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('multiple=""');
    expect(markup).toContain("Choice A");
    expect(markup).toContain("Choice B");
    expect(markup).toContain("Decline");
    expect(markup).toContain("Cancel");
  });

  it("opens native browser flows without a token input and documents real headless boundaries", () => {
    const markup = render({ id: "url", kind: "url", message: "Authenticate", url: "https://example.com/login" });
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("I completed this step");
    expect(markup).not.toContain("<input");
    const panel = renderToStaticMarkup(<ManagedRuntimePanel workId="fixture" runId="run" />);
    expect(panel).toContain("No other repository");
    expect(panel).toContain("computer-use");
    expect(panel).toContain("MCP Apps");
    expect(panel).toContain("in a local Terminal");
    expect(panel).toContain("No App registration is needed");
    expect(panel).not.toContain('type="password"');
  });
});
