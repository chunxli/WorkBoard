import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseIqToolPermissionsPanel, type useCaseIqToolPermissions } from "./CaseIqToolPermissionsPanel";
function render(approved: boolean, managed = false, available = true,
  overrides: Partial<ReturnType<typeof useCaseIqToolPermissions>> = {}) {
  const permissions: ReturnType<typeof useCaseIqToolPermissions> = {
    status: { sessionId: "synthetic", available, blockedReason: available ? null : "Wait for current Run.",
      servers: [{ serverName: "SupportIQ", tools: [{ name: "case_get", approved, managed }], autoApprove: false }] },
    busy: null, notice: null, error: null, loading: false, checking: false, checkedAt: null,
    configurationHref: "/work/work?panel=mcp",
    decide: vi.fn(), approveRequested: vi.fn(), setAutomatic: vi.fn(), refreshManually: vi.fn(), ...overrides,
  };
  return renderToStaticMarkup(<CaseIqToolPermissionsPanel permissions={permissions} />);
}
describe("per-MCP tool consent", () => {
  it("distinguishes sign-in from permission and keeps automatic approval off by default", () => {
    const markup = render(false);
    expect(markup).toContain("Sign-in is not tool approval");
    expect(markup).toContain("SupportIQ(case_get)");
    expect(markup).toContain("Not approved");
    expect(markup).toContain("Allow this tool");
    expect(markup).not.toContain("Allow All");
    expect(markup).toContain("organization restrictions are unchanged");
    expect(markup).toContain("Allow all requested tools (1)");
    expect(markup).toContain("including future tools");
    expect(markup).toContain("write-capable tools");
    expect(markup).not.toContain('checked=""');
  });
  it("shows revocable Work/session approval without claiming case access or global privileges", () => {
    const markup = render(true);
    expect(markup).toContain("Approved for this Work/session");
    expect(markup).toContain("Revoke tool approval");
  });
  it("keeps organization-managed requirements visible even when a local rule exists", () => {
    expect(render(false, true)).toContain("Organization approval required");
    const markup = render(true, true);
    expect(markup).toContain("organization approval still required");
    expect(markup).not.toContain("Approved for this Work/session");
  });
  it("prevents editing frozen active-run policy", () => {
    const markup = render(false, false, false);
    expect(markup).toContain("disabled");
    expect(markup).toContain("Wait for current Run.");
  });
  it("announces loading and refresh progress while preventing duplicate decisions", () => {
    const loading = render(false, false, true, { loading: true, status: null });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading this session");
    const checking = render(false, false, true, { checking: true });
    expect(checking).toContain("Checking tool approvals...");
    expect(checking).toContain("disabled");
  });
  it("shows a dated refresh result and names each accessible decision precisely", () => {
    const checkedAt = "2026-11-10T01:32:00.000Z";
    const markup = render(false, false, true, { checkedAt });
    expect(markup).toContain(`dateTime="${checkedAt}"`);
    expect(markup).toContain("No task was started");
    expect(markup).toContain('aria-label="Allow SupportIQ(case_get) for this Work/session"');
    expect(markup).toContain("1 awaiting approval");
    expect(markup).toContain("break-all");
    expect(markup).toContain("Tool approval help");
  });
  it("keeps decisions disabled after a failed check and does not present an old refresh as successful", () => {
    const markup = render(false, false, true, { error: "Approval state unavailable.", checkedAt: "2026-11-10T01:32:00.000Z" });
    expect(markup).toContain("Approval state unavailable.");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Tool approvals checked at");
  });
  it("clearly shows explicit automatic mode without offering misleading single-tool revocation", () => {
    const markup = render(false, false, true, { status: {
      sessionId: "synthetic", available: true, blockedReason: null,
      servers: [{ serverName: "SupportIQ", autoApprove: true, tools: [{ name: "case_get", approved: false, managed: false }] }],
    } });
    expect(markup).toContain('checked=""');
    expect(markup).toContain("Automatic approval on");
    expect(markup).toContain("Automatically approved for this Work/session");
    expect(markup).not.toContain("Allow this tool");
    expect(markup).not.toContain("Revoke tool approval");
    expect(markup).toContain("Turning it off keeps existing individual approvals");
  });
  it("does not show managed tools as automatically approved", () => {
    const markup = render(false, true, true, { status: {
      sessionId: "synthetic", available: true, blockedReason: null,
      servers: [{ serverName: "SupportIQ", autoApprove: true, tools: [{ name: "restricted_tool", approved: false, managed: true }] }],
    } });
    expect(markup).toContain("Organization approval required");
    expect(markup).not.toContain("Automatically approved for this Work/session");
  });
  it("groups MCPs separately without treating one automatic choice as a global grant", () => {
    const markup = render(false, false, true, { status: {
      sessionId: "synthetic", available: true, blockedReason: null, servers: [
        { serverName: "SupportIQ", autoApprove: true, tools: [] },
        { serverName: "safewright", autoApprove: false, tools: [{ name: "browser_snapshot", approved: false, managed: false }] },
      ],
    } });
    expect(markup).toContain('aria-label="CaseIQ MCP tool approvals"');
    expect(markup).toContain('aria-label="safewright tool approvals"');
    expect(markup).toContain('aria-label="Allow safewright(browser_snapshot) for this Work/session"');
    expect(markup).toContain('aria-label="Allow all requested tools for safewright (1)"');
    expect(markup).toContain("Automatically allow all safewright tools");
    expect(markup).toContain("no arbitrary server can be added");
    expect(markup).toContain("do not authorize any other MCP");
    expect(markup).toContain("runtime-access-banner");
    expect(markup).toContain('<details data-runtime-banner="">');
    expect(markup).not.toContain('<details data-runtime-banner="" open');
    expect(markup).toContain("ui-subtle-button");
    expect(markup).not.toContain("ui-secondary-button");
  });
});
