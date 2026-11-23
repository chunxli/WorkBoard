import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PairedSessionPanels, { PairedFollowUpReceipt, PairedFollowUpTargets, PairedLaneToolbar, readPairedSessionView } from "./PairedSessionPanels";

describe("paired Session reading controls", () => {
  const renderPanels = (view: "both" | "CLI", locked = false) => renderToStaticMarkup(
    <PairedSessionPanels view={view} locked={locked} setView={() => {}} renderLane={(lane) => <p>{lane} test history</p>} />,
  );

  it("associates the accessible comparison divider and both reading jumps with the exact Sessions", () => {
    const markup = renderPanels("both");
    const cliId = markup.match(/id="([^"]*)" class="work-paired-lane" data-lane="CLI"/)?.[1];
    const caseIqId = markup.match(/id="([^"]*)" class="work-paired-lane" data-lane="CASEIQ"/)?.[1];
    expect(cliId).toBeTruthy();
    expect(caseIqId).toBeTruthy();
    expect(markup).toContain(`aria-label="Resize paired Sessions" aria-controls="${cliId}" aria-orientation="vertical" aria-valuemin="35" aria-valuemax="65" aria-valuenow="50"`);
    expect(markup).toContain('aria-valuetext="Copilot CLI 50%, CaseIQ 50%"');
    expect(markup).toContain(`aria-label="Jump to Copilot CLI" aria-controls="${cliId}"`);
    expect(markup).toContain(`aria-label="Jump to CaseIQ" aria-controls="${caseIqId}"`);
  });

  it("leaves reading controls usable when a send is locked, but omits them in focused view", () => {
    const locked = renderPanels("both", true);
    expect(locked).toContain('aria-label="Resize paired Sessions"');
    expect(locked).toMatch(/type="button" class="work-toolbar-action" aria-label="Jump to CaseIQ"/);
    expect(locked).toContain("Target locked for this draft");
    const focused = renderPanels("CLI");
    expect(focused).not.toContain('aria-label="Resize paired Sessions"');
    expect(focused).not.toContain('aria-label="Jump to CaseIQ"');
    expect(focused).toContain("CASEIQ test history");
  });

  it("highlights only the exact Session's jump control when unread messages are appended", () => {
    const toolbar = (lane: "CLI" | "CASEIQ", newMessages: boolean, raw = false) => renderToStaticMarkup(
      <PairedLaneToolbar lane={lane} sessionId={`${lane}-fixture-session`} headingId="lane-heading" raw={raw}
        hasRun showLatest={() => {}} toggleRaw={() => {}} newMessages={newMessages} />,
    );
    expect(toolbar("CLI", true)).toContain('data-new-messages="true"');
    expect(toolbar("CLI", true)).toContain('aria-label="Jump to new Copilot CLI messages"');
    expect(toolbar("CASEIQ", false)).not.toContain("data-new-messages");
    expect(toolbar("CASEIQ", false)).toContain('aria-label="Latest messages"');
    expect(toolbar("CLI", true, true)).not.toContain("data-new-messages");
  });

  it("lets users browse existing output even without a current Run and keeps the action non-submitting", () => {
    const markup = renderToStaticMarkup(<PairedLaneToolbar lane="CASEIQ" sessionId="fixture-session" headingId="lane-heading"
      raw={false} hasRun={false} toggleRaw={() => {}} resultFiles={{ panelId: "work-files", open: () => {} }} />);
    expect(markup).toMatch(/type="button"[^>]+aria-label="Open CaseIQ result files" aria-controls="work-files"/);
    expect(markup).not.toContain('aria-label="Raw output"');
  });
});

describe("paired Follow Up feedback", () => {
  it("renders distinct submission outcomes with exact Run links that keep the Conversation open", () => {
    const markup = renderToStaticMarkup(<PairedFollowUpReceipt onDismiss={() => {}} receipt={{
      runs: [
        { lane: "CLI", sessionId: "cli-fixture-session", runId: "cli-fixture-run", queued: true },
        { lane: "CASEIQ", sessionId: "caseiq-fixture-session", runId: "caseiq-fixture-run", queued: false },
      ],
    }} />);
    expect(markup).toContain('aria-label="Last confirmed Follow Up"');
    expect(markup).toMatch(/href="\/runs\/cli-fixture-run"[^>]+target="_blank"[^>]+aria-label="Open Copilot CLI Run in a new tab: Added to queue"/);
    expect(markup).toMatch(/href="\/runs\/caseiq-fixture-run"[^>]+target="_blank"[^>]+aria-label="Open CaseIQ Run in a new tab: Accepted"/);
    expect(markup).toContain("Open Run for current status.");
    expect(markup).toContain('aria-label="Dismiss Follow Up receipt"');
  });

  it("does not display a receipt before a send is confirmed and omits untargeted Sessions", () => {
    const empty = renderToStaticMarkup(<PairedFollowUpReceipt onDismiss={() => {}} receipt={null} />);
    expect(empty).not.toContain("Last confirmed Follow Up");
    const focused = renderToStaticMarkup(<PairedFollowUpReceipt onDismiss={() => {}} receipt={{
      runs: [{ lane: "CASEIQ", sessionId: "caseiq-fixture-session", runId: "caseiq-fixture-run", queued: false }],
    }} />);
    expect(focused).not.toContain("Copilot CLI");
    expect(focused).toContain("Follow Up confirmed. CaseIQ: accepted.");
  });
});

describe("paired Follow Up destinations", () => {
  it("distinguishes Sessions ready to send from those that will queue", () => {
    const markup = renderToStaticMarkup(<PairedFollowUpTargets view="both" blockedReason={null} locked={false} hintId="hints"
      controls={{ CLI: { parentRunId: "cli", blockedReason: null, queued: false },
        CASEIQ: { parentRunId: "caseiq", blockedReason: null, queued: true } }} />);
    expect(markup).toMatch(/data-state="ready"[^>]*>.*<strong>Copilot CLI<\/strong><span>Ready<\/span>/);
    expect(markup).toMatch(/data-state="queued"[^>]*>.*<strong>CaseIQ<\/strong><span>Will queue<\/span>/);
  });

  it("explains which Session prevents sending to both, without surfacing reasons from an untargeted lane", () => {
    const controls = {
      CLI: { parentRunId: "cli", blockedReason: null, queued: false },
      CASEIQ: { parentRunId: null, blockedReason: "Finish SupportIQ sign-in first.", queued: false },
    };
    const both = renderToStaticMarkup(<PairedFollowUpTargets view="both" blockedReason={null} locked={false} hintId="hints" controls={controls} />);
    expect(both).toContain("Both Sessions must be available to send together.");
    expect(both).toContain("<strong>CaseIQ:</strong> Finish SupportIQ sign-in first.");
    const focused = renderToStaticMarkup(<PairedFollowUpTargets view="CLI" blockedReason={null} locked={false} hintId="hints" controls={controls} />);
    expect(focused).not.toContain("CaseIQ");
    expect(focused).toContain("Ready");
  });

  it("keeps the submitted destination explicit even when permissions change during a locked send", () => {
    const markup = renderToStaticMarkup(<PairedFollowUpTargets view="CASEIQ" blockedReason="Restore the Work." locked hintId="hints"
      controls={{ CASEIQ: { parentRunId: null, blockedReason: "Finish SupportIQ sign-in first.", queued: false } }} />);
    expect(markup).toContain('data-state="locked"');
    expect(markup).toContain("<strong>CaseIQ</strong><span>Locked</span>");
    expect(markup).not.toContain("SupportIQ");
    expect(markup).not.toContain("Restore");
  });

  it.each([[null, "both"], ["cli", "CLI"], ["caseiq", "CASEIQ"], ["unrecognized", "both"]])(
    "reads view %s as %s", (query, expected) => { expect(readPairedSessionView(query)).toBe(expected); },
  );
});
