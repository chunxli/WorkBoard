import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionConversation, { conversationControlCapabilities, ConversationMessage, ConversationTimelineEntries, handleConversationComposerKeyDown, handleConversationHistoryWheel, readEarlierConversationPages } from "./SessionConversation";
import { normalizeConversationEvent, type ConversationEvent } from "@/lib/session-conversation";
import { conversationTimeline, conversationToolActivityAt, withPendingFollowUp } from "@/lib/conversation-activity";
import * as authentication from "./CaseIqAuthenticationPanel";
import { CaseIqStartupFeedback } from "./CaseIqStartupStatus";

const navigation = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
beforeEach(() => { navigation.query = ""; });

describe("session conversation toolbar", () => {
  const pairedLayout = {
    lanes: {
      CLI: { sessionId: "cli-synthetic-session", runId: "cli-fixture-run", initialLog: "", isLive: true, awaitingRunStart: true, outputFormat: "text" as const },
      CASEIQ: { sessionId: "caseiq-synthetic-session", runId: "caseiq-fixture-run", initialLog: "", isLive: false, awaitingRunStart: false, outputFormat: "json" as const },
    },
    sendBlockedReason: null,
  };
  const pairedMarkup = (withFiles = false) => renderToStaticMarkup(<SessionConversation workId="paired-work" runId={null} runtimeEngine={null}
    initialLog="" isLive={false} historySync={false} outputFormat="text"
    workHeader={<h1>Paired Work</h1>} paired={pairedLayout}
    fileBrowser={withFiles ? <p>Paired Work files</p> : undefined} />);

  it("uses compact independent lane tools and one clearly targeted composer in Both mode", () => {
    const markup = pairedMarkup();
    expect(markup).toContain("work-detail-layout-paired");
    expect(markup).toContain("--work-detail-viewport-height:");
    expect(markup).toContain('data-paired-view="both"');
    expect(markup.match(/aria-label="Raw output" aria-pressed="false"/g)).toHaveLength(2);
    expect(markup).not.toContain('aria-label="Session view"');
    expect(markup).toContain('aria-label="Copilot CLI conversation"');
    expect(markup).toContain('aria-label="CaseIQ conversation"');
    expect(markup).toContain('aria-label="Follow Up destinations"');
    expect(markup.match(/data-state="checking"/g)).toHaveLength(2);
    expect(markup.match(/id="session-follow-up"/g)).toHaveLength(1);
    expect(markup).toContain("Send to both Sessions");
    const groups = [...markup.matchAll(/<details name="([^"]+)" class="work-paired-resource"/g)].map((match) => match[1]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups).size).toBe(2);
  });

  it("restores a focused Session from the URL while keeping the other lane mounted and untargeted", () => {
    navigation.query = "sessionView=caseiq";
    const markup = pairedMarkup();
    expect(markup).toContain('data-paired-view="CASEIQ"');
    expect(markup).toMatch(/data-lane="CLI"[^>]+aria-label="Copilot CLI session" hidden=""/);
    expect(markup).not.toContain("Send to both Sessions");
    expect(markup).toContain("Send to CaseIQ");
    expect(markup.match(/data-state="checking"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Copilot CLI conversation"');
  });

  it("only exposes exact paired results shortcuts when a Work files pane is wired", () => {
    const markup = pairedMarkup(true);
    const filesId = markup.match(/<aside id="([^"]*)" aria-label="Work files"/)?.[1];
    expect(filesId).toBeTruthy();
    expect(markup).toContain(`aria-label="Open Copilot CLI result files" aria-controls="${filesId}"`);
    expect(markup).toContain(`aria-label="Open CaseIQ result files" aria-controls="${filesId}"`);
    expect(pairedMarkup()).not.toContain('aria-label="Open CaseIQ result files"');
  });

  it("renders two keyboard-accessible dividers between the Work panes", () => {
    const markup = renderToStaticMarkup(<SessionConversation workId="resize-work" runId={null} runtimeEngine={null}
      initialLog="" isLive={false} historySync={false} outputFormat="text"
      workHeader={<h1>Synthetic Work</h1>}
      fileBrowser={<p>Synthetic Work Files</p>} />);
    expect(markup).not.toContain("work-detail-layout-paired");
    expect(markup).toContain('class="work-workspace-grid has-files"');
    expect(markup).not.toMatch(/<div class="work-workspace-grid[^"]*"[^>]*style="[^"]*--work-/);
    const left = markup.match(/aria-label="Resize Work sidebar" aria-controls="([^"]+)"/);
    const right = markup.match(/aria-label="Resize Work files" aria-controls="([^"]+)"/);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(markup.match(/role="separator" tabindex="0"/g)).toHaveLength(2);
    expect(markup.match(/aria-orientation="vertical"/g)).toHaveLength(2);
    expect(markup.indexOf(`id="${left?.[1]}"`)).toBeLessThan(markup.indexOf('aria-label="Resize Work sidebar"'));
    expect(markup.indexOf('aria-label="Resize Work sidebar"')).toBeLessThan(markup.indexOf('id="session-follow-up"'));
    expect(markup.indexOf('id="session-follow-up"')).toBeLessThan(markup.indexOf('aria-label="Resize Work files"'));
    expect(markup.indexOf('aria-label="Resize Work files"')).toBeLessThan(markup.indexOf(`id="${right?.[1]}"`));
  });

  it("omits dividers for embedded Conversations and keeps only the sidebar divider without a files pane", () => {
    const props = { workId: "resize-work", runId: null, runtimeEngine: null, initialLog: "", isLive: false,
      historySync: false, outputFormat: "text" as const };
    expect(renderToStaticMarkup(<SessionConversation {...props} />)).not.toContain('role="separator"');
    const markup = renderToStaticMarkup(<SessionConversation {...props} workHeader={<h1>Synthetic Work</h1>} />);
    expect(markup.match(/role="separator"/g)).toHaveLength(1);
    expect(markup).toContain("Resize Work sidebar");
    expect(markup).not.toContain("Resize Work files");
  });

  it("keeps actionable sign-in guidance outside history scrolling, immediately above the Follow Up draft", () => {
    const hook = vi.spyOn(authentication, "useCaseIqAuthentication").mockReturnValue({
      status: { available: false, blockedReason: "Waiting for TSE.", authenticationVerified: false,
        operation: { id: "operation", sessionId: "session", sourceRunId: "run", startedAt: "2026-11-12T00:00:00.000Z",
          status: "active", reserved: true, phase: "native-started", message: "Waiting for TSE." } },
      error: null, opening: false, uncertain: false, checking: false, checkedAt: null, trustWorkFolder: true,
      commandCopied: false, clipboardError: null, reserved: true, setTrustWorkFolder: vi.fn(),
      copyCommand: vi.fn(), refresh: vi.fn(), refreshManually: vi.fn(), start: vi.fn(), reportError: vi.fn(),
    });
    try {
      const markup = renderToStaticMarkup(<SessionConversation workId="work" runId="run" runtimeEngine="CASEIQ"
        initialLog="" isLive={false} historySync={false} outputFormat="json" />);
      expect(markup).toContain('aria-label="SupportIQ sign-in action"');
      expect(markup.indexOf('class="work-conversation-composer')).toBeLessThan(markup.indexOf('aria-label="SupportIQ sign-in action"'));
      expect(markup.indexOf('aria-label="SupportIQ sign-in action"')).toBeLessThan(markup.indexOf('id="session-follow-up"'));
      expect(markup.match(/aria-label="SupportIQ sign-in action"/g)).toHaveLength(1);
      expect(markup).toContain("No task prompts.");
    } finally { hook.mockRestore(); }
  });

  it("opens a linked Work MCP tab without unmounting the conversation or composer", () => {
    navigation.query = "panel=mcp";
    const markup = renderToStaticMarkup(<SessionConversation workId="work" runId="run" runtimeEngine="CASEIQ"
      initialLog="" isLive={false} historySync={false} outputFormat="json"
      workHeader={<h1>Synthetic Work</h1>}
      panels={[{ id: "mcp", label: "MCP configuration", content: <p>Current Work MCP settings</p> }]} />);
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>MCP configuration<\/button>/);
    expect(markup).toMatch(/role="tabpanel"[^>]*hidden=""[^>]*>[\s\S]*aria-label="CaseIQ access controls"/);
    expect(markup).toContain("Current Work MCP settings");
    expect(markup).toContain('id="session-follow-up"');
    expect(markup).toContain('type="button" class="ui-subtle-button">MCP configuration</button>');
  });

  it("ignores a panel link that is not available in the Work", () => {
    navigation.query = "panel=unavailable";
    const markup = renderToStaticMarkup(<SessionConversation workId="work" runId={null} runtimeEngine={null}
      initialLog="" isLive={false} historySync={false} outputFormat="text"
      workHeader={<h1>Synthetic Work</h1>} />);
    expect(markup).toMatch(/aria-selected="true"[^>]*>Conversation<\/button>/);
  });

  it("places current CaseIQ initialization inside the timeline before the composer, not above history", () => {
    const markup = renderToStaticMarkup(<SessionConversation
      workId="startup-work" runId="current-follow-up" runtimeEngine="CASEIQ"
      initialLog="" isLive historySync={false} outputFormat="json"
    />);
    expect(markup).toContain('aria-label="CaseIQ Run startup status"');
    expect(markup).toContain("View startup logs");
    expect(markup.indexOf('role="log"')).toBeLessThan(markup.indexOf('aria-label="CaseIQ Run startup status"'));
    expect(markup.indexOf('aria-label="CaseIQ Run startup status"')).toBeLessThan(markup.indexOf('id="session-follow-up"'));
    expect(markup).toContain('data-startup-run-id="current-follow-up"');
    expect(markup.match(/aria-label="CaseIQ Run startup status"/g)).toHaveLength(1);
    expect(markup).toContain("Earlier conversation messages do not hide its initialization");
  });

  describe("current Run progress in chronological conversation flow", () => {
    it.each([
      { toolAt: "2026-11-10T00:00:01.000Z", showStartup: true },
      { toolAt: "2026-11-10T00:01:01.000Z", showStartup: false },
    ])("hands off only when a displayed tool belongs to this startup attempt: $toolAt", ({ toolAt, showStartup }) => {
      const startedAt = "2026-11-10T00:01:00.000Z";
      const events = [normalizeConversationEvent({
        type: "tool.execution_start", timestamp: toolAt,
        data: { toolName: "synthetic-tool", toolCallId: "tool" },
      }, "history", 0)!];
      const markup = renderToStaticMarkup(<ConversationTimelineEntries
        timeline={conversationTimeline(events)} workId="work" isLive
        startup={<CaseIqStartupFeedback observation={{
          runId: "current-run", status: "RUNNING", startedAt, unavailableReason: null,
          startup: { phase: "processing", attempt: 1, startedAt, updatedAt: startedAt, steps: [] },
        }} error={null} now={Date.parse(startedAt) + 10_000} onRetry={vi.fn()}
          toolActivityAt={conversationToolActivityAt(events)} />} />);
      expect(markup).toContain("Tools &amp; run details");
      expect(markup.includes('aria-label="CaseIQ Run startup status"')).toBe(showStartup);
      expect(markup.includes("CaseIQ is working on your Prompt")).toBe(showStartup);
    });

    function history() {
      return [
        normalizeConversationEvent({ type: "user.message", timestamp: "2026-11-10T00:00:00Z", data: { content: "Repeated synthetic request" } }, "history", 0)!,
        normalizeConversationEvent({ type: "assistant.message", timestamp: "2026-11-10T00:00:01Z", data: { content: "Previous completed response" } }, "history", 100)!,
      ];
    }
    const startup = <section aria-label="Current Run progress" data-startup-run-id="new-run">Initializing current CaseIQ Run</section>;

    it("follows the exact new pending request even when its text repeats an older request", () => {
      const timeline = conversationTimeline(withPendingFollowUp(history(), {
        runId: "new-run", text: "Repeated synthetic request", timestamp: "2026-11-10T00:01:00Z",
      }));
      const markup = renderToStaticMarkup(<ConversationTimelineEntries timeline={timeline} workId="work" isLive
        pendingRun={{ id: "new-run", status: "RUNNING" }} startup={startup} />);
      expect(markup.indexOf("Previous completed response")).toBeLessThan(markup.indexOf('href="/runs/new-run"'));
      expect(markup.indexOf('href="/runs/new-run"')).toBeLessThan(markup.indexOf("Initializing current CaseIQ Run"));
      expect(markup.match(/data-startup-run-id="new-run"/g)).toHaveLength(1);
    });

    it("stays at the current Run's live position after native messages replace the pending request", () => {
      const events = [...history(),
        normalizeConversationEvent({ type: "user.message", timestamp: "2026-11-10T00:01:01Z", data: { content: "Native current request" } }, "history", 200)!,
        normalizeConversationEvent({ type: "tool.execution_start", timestamp: "2026-11-10T00:01:02Z",
          data: { toolName: "synthetic-tool", toolCallId: "current-tool" } }, "history", 300)!,
        normalizeConversationEvent({ type: "assistant.message", timestamp: "2026-11-10T00:01:03Z",
          data: { content: "Current visible response" } }, "history", 400)!,
      ];
      const markup = renderToStaticMarkup(<ConversationTimelineEntries timeline={conversationTimeline(events)} workId="work" isLive startup={startup} />);
      expect(markup.indexOf("Previous completed response")).toBeLessThan(markup.indexOf("Native current request"));
      expect(markup).toContain("Current visible response");
      expect(markup.indexOf("Current visible response")).toBeLessThan(markup.indexOf("Initializing current CaseIQ Run"));
    });

    it("does not label a queued or unrelated pending request as the active Run", () => {
      const timeline = conversationTimeline(withPendingFollowUp(history(), {
        runId: "queued-run", text: "Queued request", timestamp: "2026-11-10T00:02:00Z",
      }));
      const markup = renderToStaticMarkup(<ConversationTimelineEntries timeline={timeline} workId="work" isLive
        pendingRun={{ id: "new-run", status: "RUNNING" }} />);
      expect(markup).not.toContain('href="/runs/new-run"');
      expect(markup).not.toContain("Current Run progress");
    });

    it("does not synthesize startup history when no live progress is supplied, as in Pins or finished Runs", () => {
      const events = history();
      const before = JSON.stringify(events);
      const markup = renderToStaticMarkup(<ConversationTimelineEntries timeline={conversationTimeline(events)} workId="work" isLive={false} />);
      expect(markup).not.toContain("Initializing current CaseIQ Run");
      expect(JSON.stringify(events)).toBe(before);
    });
  });

  it.each(["CLI", "SDK", null] as const)("does not attach CaseIQ initialization to %s Runs", (runtimeEngine) => {
    const markup = renderToStaticMarkup(<SessionConversation workId="work" runId="run" runtimeEngine={runtimeEngine}
      initialLog="" isLive historySync={false} outputFormat="json" />);
    expect(markup).not.toContain('aria-label="CaseIQ Run startup status"');
  });

  it("removes CaseIQ startup animation when the current Run has ended", () => {
    const markup = renderToStaticMarkup(<SessionConversation workId="work" runId="run" runtimeEngine="CASEIQ"
      initialLog="" isLive={false} historySync={false} outputFormat="json" />);
    expect(markup).not.toContain('aria-label="CaseIQ Run startup status"');
  });

  it.each(["CLI", "SDK", "CASEIQ"] as const)("shows actual %s startup output in the default Conversation before messages exist", (runtimeEngine) => {
    const markup = renderToStaticMarkup(<SessionConversation
      workId="startup-work" runId="startup-run" runtimeEngine={runtimeEngine}
      initialLog="[setup] Synthetic dependency and authentication preparation"
      isLive historySync={false} outputFormat="json"
    />);
    expect(markup).toContain('aria-label="Run startup and output"');
    expect(markup).toContain("[setup] Synthetic dependency and authentication preparation");
    expect(markup).toContain("not recorded conversation messages");
    expect(markup).toContain("Live output");
    expect(markup).toContain('role="tab" aria-selected="true"');
  });

  it("keeps failed CaseIQ startup diagnostics visible rather than waiting for nonexistent messages", () => {
    const markup = renderToStaticMarkup(<SessionConversation
      workId="startup-work" runId="startup-run" runtimeEngine="CASEIQ"
      initialLog="[setup] Synthetic package authorization required"
      isLive={false} historySync={false} outputFormat="json"
      runError={<p role="alert">Synthetic initialization timed out before the Prompt process started.</p>}
    />);
    expect(markup).toContain("[setup] Synthetic package authorization required");
    expect(markup).toContain("Synthetic initialization timed out");
    expect(markup).toContain('aria-label="Run startup and output"');
    expect(markup).not.toContain("Live output");
  });

  it("renders one labelled heading with its view switch and supplied Run actions above the unchanged log", () => {
    const markup = renderToStaticMarkup(<SessionConversation
      workId="layout-work" runId="layout-run" runtimeEngine="SDK" initialLog="" isLive={false}
      historySync={false} outputFormat="text"
      runActions={<Link href="/runs/layout-run">Full details</Link>}
    />);
    expect(markup.match(/id="session-conversation-heading"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Conversation Pins"');
    expect(markup.indexOf('id="session-conversation-heading"')).toBeLessThan(markup.indexOf('role="tablist"'));
    expect(markup.indexOf('role="tablist"')).toBeLessThan(markup.indexOf("Full details"));
    expect(markup.indexOf("Full details")).toBeLessThan(markup.indexOf('role="log"'));
    expect(markup).toContain('aria-label="Session view"');
    expect(markup).toContain('role="tab" aria-selected="true"');
    expect(markup).toContain("max-h-[65dvh] min-h-48");
    expect(markup.indexOf('role="log"')).toBeLessThan(markup.indexOf('id="session-follow-up"'));
  });

  it("keeps the heading, view switch and composer available before the first Run", () => {
    const markup = renderToStaticMarkup(<SessionConversation
      workId="layout-work" runId={null} runtimeEngine={null} initialLog="" isLive={false}
      historySync={false} outputFormat="text"
    />);
    expect(markup).toContain("Session conversation");
    expect(markup).toContain("Conversation");
    expect(markup).toContain("Raw output");
    expect(markup).toContain('id="session-follow-up"');
    expect(markup).not.toContain("Full details");
    expect(markup).not.toContain('aria-label="Run startup and output"');
  });

  it("provides a unified workspace with mounted hidden panels and no removed record summaries", () => {
    const markup = renderToStaticMarkup(<SessionConversation
      workId="workspace" runId="run" runtimeEngine="SDK" initialLog="" isLive={false} historySync={false} outputFormat="text"
      workHeader={<h1>Workspace title</h1>}
      panels={[{ id: "settings", label: "Execution settings", content: <input defaultValue="Retained setting draft" /> }]}
      fileBrowser={<p>Read-only Work files</p>}
    />);
    expect(markup).toContain("work-detail-unified-toolbar");
    expect(markup).toContain('aria-label="Work sections"');
    expect(markup).toContain("work-conversation-composer");
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('value="Retained setting draft"');
    expect(markup).not.toContain("Runs in this session");
    expect(markup).not.toContain("Steering delivery audit");
  });
});

describe("engine-specific conversation controls", () => {
  const data = { anchorRunId: "run", steeringRunId: "run", canSteer: true, canFollowUp: false, canQueue: true };
  it("allows live Steering only for the matching actual SDK Run", () => {
    expect(conversationControlCapabilities(data, "SDK", "run", true)).toEqual({ canSteer: true, canFollowUp: false, canQueue: true });
    expect(conversationControlCapabilities(data, "CLI", "run", true)).toEqual({ canSteer: false, canFollowUp: false, canQueue: true });
    expect(conversationControlCapabilities(data, null, "run", true).canSteer).toBe(false);
    expect(conversationControlCapabilities(data, "SDK", "new-run", true)).toEqual({ canSteer: false, canFollowUp: false, canQueue: false });
  });
  it("allows finished native Follow up as soon as the current server state permits it", () => {
    const finished = { ...data, canSteer: false, canFollowUp: true, canQueue: false };
    expect(conversationControlCapabilities(finished, "CLI", "run", false)).toEqual({ canSteer: false, canFollowUp: true, canQueue: false });
    expect(conversationControlCapabilities(finished, "CLI", "new-run", false).canFollowUp).toBe(false);
  });
  it("requires current server queue permission without disabling independent SDK Steering", () => {
    expect(conversationControlCapabilities({ ...data, canQueue: false }, "SDK", "run", true))
      .toEqual({ canSteer: true, canFollowUp: false, canQueue: false });
    expect(conversationControlCapabilities(data, "SDK", "run", false).canQueue).toBe(false);
  });
  it.each(["CLI", "SDK"] as const)("keeps the %s layout while separating SDK live controls", (runtimeEngine) => {
    const markup = renderToStaticMarkup(<SessionConversation workId="work" runId="run" runtimeEngine={runtimeEngine}
      initialLog="" isLive historySync={false} outputFormat="text" />);
    expect(markup).toContain('role="log"');
    expect(markup).toContain('id="session-follow-up"');
    expect(markup.includes('aria-label="Live Copilot controls"')).toBe(runtimeEngine === "SDK");
    expect(markup).toContain("Add to Queue");
    expect(markup).not.toContain("Send Follow Up");
    if (runtimeEngine === "CLI") {
      expect(markup).toContain("Queue a follow-up");
      expect(markup).toContain("after the current Run");
      expect(markup.match(/<textarea[^>]*id="session-follow-up"[^>]*>/)?.[0]).not.toContain("disabled");
      expect(markup).not.toContain("Steer now");
    }
  });
});

describe("conversation composer keyboard shortcuts", () => {
  function keyEvent(overrides: Partial<Parameters<typeof handleConversationComposerKeyDown>[0]> = {}) {
    return {
      key: "Enter", shiftKey: false, repeat: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault: vi.fn(),
      ...overrides,
    };
  }

  it("submits on Enter without inserting a newline", () => {
    const event = keyEvent();
    const submit = vi.fn();
    handleConversationComposerKeyDown(event, submit);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter available for a newline", () => {
    const event = keyEvent({ shiftKey: true });
    const submit = vi.fn();
    handleConversationComposerKeyDown(event, submit);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("does not submit IME confirmation: %j", (nativeEvent) => {
    const event = keyEvent({ nativeEvent });
    const submit = vi.fn();
    handleConversationComposerKeyDown(event, submit);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not repeatedly submit or add newlines when Enter is held down", () => {
    const event = keyEvent({ repeat: true });
    const submit = vi.fn();
    handleConversationComposerKeyDown(event, submit);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("leaves other keys unchanged", () => {
    const event = keyEvent({ key: "a" });
    const submit = vi.fn();
    handleConversationComposerKeyDown(event, submit);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["CLI", "SDK"] as const)("shows a small accessible keyboard hint for the %s composer", (runtimeEngine) => {
    const markup = renderToStaticMarkup(<SessionConversation workId="work" runId="run" runtimeEngine={runtimeEngine}
      initialLog="" isLive historySync={false} outputFormat="text" />);
    const describedBy = markup.match(/<textarea[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`id="${describedBy}" class="text-[11px] leading-5 text-neutral-500"`);
    expect(markup).toContain("Enter to queue · Shift+Enter for a new line");
  });
  it("keeps Enter-to-send and Send Follow Up when the Run is finished", () => {
    const markup = renderToStaticMarkup(<SessionConversation workId="work" runId="run" runtimeEngine="CLI"
      initialLog="" isLive={false} historySync={false} outputFormat="text" />);
    expect(markup).toContain("Send Follow Up");
    expect(markup).toContain("Enter to send · Shift+Enter for a new line");
    expect(markup).not.toContain("Add to Queue");
  });
});

describe("upward conversation history scrolling", () => {
  class ScrollElement extends EventTarget {
    scrollTop = 0;
    scrollHeight = 1000;
    clientHeight = 400;
  }

  beforeEach(() => { vi.stubGlobal("HTMLElement", ScrollElement); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function wheelEvent(overrides: Partial<Parameters<typeof handleConversationHistoryWheel>[0]> = {}) {
    const container = new ScrollElement();
    return {
      deltaY: -120, ctrlKey: false, currentTarget: container,
      nativeEvent: { composedPath: () => [container] },
      ...overrides,
    };
  }

  it("loads only on the next upward wheel gesture after reaching the top", () => {
    const event = wheelEvent();
    const loadEarlier = vi.fn();
    event.currentTarget.scrollTop = 40;
    handleConversationHistoryWheel(event, loadEarlier);
    expect(loadEarlier).not.toHaveBeenCalled();
    event.currentTarget.scrollTop = 0;
    expect(loadEarlier).not.toHaveBeenCalled();
    handleConversationHistoryWheel(event, loadEarlier);
    expect(loadEarlier).toHaveBeenCalledOnce();
  });

  it.each([
    { deltaY: 120 },
    { deltaY: 0 },
    { ctrlKey: true },
    { currentTarget: Object.assign(new ScrollElement(), { scrollTop: 0.1 }) },
  ])("does not load on downward/horizontal scrolling, zoom or before the top: %j", (overrides) => {
    const loadEarlier = vi.fn();
    handleConversationHistoryWheel(wheelEvent(overrides), loadEarlier);
    expect(loadEarlier).not.toHaveBeenCalled();
  });

  it("also recognizes a negative top offset during overscroll", () => {
    const loadEarlier = vi.fn();
    handleConversationHistoryWheel(wheelEvent({ currentTarget: Object.assign(new ScrollElement(), { scrollTop: -1 }) }), loadEarlier);
    expect(loadEarlier).toHaveBeenCalledOnce();
  });

  it("lets a nested code block scroll upward before loading conversation history", () => {
    const event = wheelEvent();
    const code = new ScrollElement();
    code.scrollTop = 80;
    event.nativeEvent.composedPath = () => [code, event.currentTarget];
    const loadEarlier = vi.fn();
    handleConversationHistoryWheel(event, loadEarlier);
    expect(loadEarlier).not.toHaveBeenCalled();
    code.scrollTop = 0;
    handleConversationHistoryWheel(event, loadEarlier);
    expect(loadEarlier).toHaveBeenCalledOnce();
  });

  it("does not mistake a scrolled ancestor outside the conversation for a nested scroller", () => {
    const event = wheelEvent();
    const ancestor = new ScrollElement();
    ancestor.scrollTop = 100;
    event.nativeEvent.composedPath = () => [event.currentTarget, ancestor];
    const loadEarlier = vi.fn();
    handleConversationHistoryWheel(event, loadEarlier);
    expect(loadEarlier).toHaveBeenCalledOnce();
  });
});

describe("conversation-aware earlier history batches", () => {
  const entry = (type: string, offset: number, content = "", agentId: string | null = null) =>
    normalizeConversationEvent({ type, agentId, data: type === "tool.execution_complete" ? { result: content, success: true } : { content } }, "history", offset)!;
  const page = (events: ConversationEvent[], previousCursor: string | null) => ({ events, previousCursor });

  it("passes tool-only, empty and subagent-only pages until new root conversation appears, retaining every page", async () => {
    const alreadyVisible = entry("assistant.message", 100, "Already loaded");
    const pages = new Map([
      ["tools", page([entry("tool.execution_complete", 40, "Tool result"), alreadyVisible], "empty")],
      ["empty", page([], "hidden")],
      ["hidden", page([entry("assistant.message", 30, " \n\t "), entry("assistant.message", 31, "Subagent output", "agent")], "answer")],
      ["answer", page([entry("assistant.message", 10, "Earlier actual answer")], "older")],
    ]);
    const read = vi.fn(async (cursor: string) => {
      const result = pages.get(cursor);
      if (!result) throw new Error(`Unexpected cursor: ${cursor}`);
      return result;
    });
    const accept = vi.fn();
    const known = new Set([alreadyVisible.id]);
    await readEarlierConversationPages("tools", read, accept, { knownIds: known, signal: new AbortController().signal });
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual(["tools", "empty", "hidden", "answer"]);
    expect(accept.mock.calls.map(([result]) => result)).toEqual([...pages.values()]);
    expect(known).toEqual(new Set([alreadyVisible.id]));
  });

  it("also stops on a newly visible attachment-only user message", async () => {
    const attached = entry("user.message", 1);
    attached.attachments = [{ id: "file", requestId: "request", uploadId: "upload", name: "image.png", storedName: "file-image.png",
      size: 12, mediaType: "image/png", sha256: "0".repeat(64) }];
    const read = vi.fn(async () => page([attached], "more"));
    await readEarlierConversationPages("start", read, vi.fn(), { signal: new AbortController().signal });
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not impose a page cap before meaningful conversation appears", async () => {
    const read = vi.fn(async (cursor: string) => {
      const position = Number(cursor);
      return page([entry(position === 20 ? "user.message" : "tool.execution_complete", position, position === 20 ? "Earlier input" : "Tool")], String(position - 1));
    });
    await readEarlierConversationPages("80", read, vi.fn(), { signal: new AbortController().signal });
    expect(read).toHaveBeenCalledTimes(61);
    expect(read).toHaveBeenLastCalledWith("20");
  });

  it("ends at the history start even if all earlier pages contain only tools or metadata", async () => {
    const read = vi.fn(async (cursor: string) => page([entry("tool.execution_complete", Number(cursor), "Tool")],
      cursor === "1" ? null : String(Number(cursor) - 1)));
    const accept = vi.fn();
    await readEarlierConversationPages("3", read, accept, { signal: new AbortController().signal });
    expect(read).toHaveBeenCalledTimes(3);
    expect(accept).toHaveBeenCalledTimes(3);
    expect(accept.mock.calls.at(-1)?.[0].previousCursor).toBeNull();
  });

  it("preserves completed pages on a later failure so Retry can resume without rereading them", async () => {
    const completed = page([entry("tool.execution_complete", 30, "Completed tool")], "2");
    const read = vi.fn().mockResolvedValueOnce(completed).mockRejectedValueOnce(new Error("Earlier history unavailable"));
    const accept = vi.fn();
    await expect(readEarlierConversationPages("3", read, accept, { signal: new AbortController().signal })).rejects.toThrow("Earlier history unavailable");
    expect(accept).toHaveBeenCalledExactlyOnceWith(completed);
    const retry = vi.fn(async () => page([entry("assistant.message", 10, "Earlier answer")], "1"));
    await readEarlierConversationPages(completed.previousCursor!, retry, accept,
      { knownIds: completed.events.map((event) => event.id), signal: new AbortController().signal });
    expect(retry).toHaveBeenCalledExactlyOnceWith("2");
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("rejects non-advancing or cyclic cursors without looping (same cursor=%s)", async (sameCursor) => {
    const read = vi.fn(async (cursor: string) => page([entry("tool.execution_complete", 1, "Tool")],
      sameCursor ? cursor : cursor === "a" ? "b" : "a"));
    await expect(readEarlierConversationPages("a", read, vi.fn(), { signal: new AbortController().signal }))
      .rejects.toThrow("Earlier history did not advance");
    expect(read).toHaveBeenCalledTimes(sameCursor ? 1 : 2);
  });

  it("does not start an already cancelled batch or accept a response after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => page([entry("assistant.message", 1, "Answer")], null));
    const accept = vi.fn();
    await expect(readEarlierConversationPages("start", read, accept, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
    const next = new AbortController();
    read.mockImplementationOnce(async () => {
      next.abort();
      return page([entry("assistant.message", 1, "Answer")], null);
    });
    await expect(readEarlierConversationPages("start", read, accept, { signal: next.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("session conversation messages", () => {
  it("enables code copying for user and assistant Markdown without adding it to inline code", () => {
    const user = normalizeConversationEvent({ type: "user.message", data: { content: "```text\nuser code\n```" } }, "copy", 0)!;
    const assistant = normalizeConversationEvent({ type: "assistant.message", data: { content: "```xml\n<sample />\n```\n\n`inline`" } }, "copy", 1)!;
    const markup = renderToStaticMarkup(<><ConversationMessage event={user} /><ConversationMessage event={assistant} /></>);
    expect(markup.match(/aria-label="Copy code"/g)).toHaveLength(2);
    expect(markup).toContain("<code>inline</code>");
  });
  it("renders a restored input as a normal dated user bubble while retaining its Run status link", () => {
    const timestamp = "2026-10-28T08:17:46.837Z";
    const [input] = withPendingFollowUp([], { runId: "pending-run", text: "Update the report", timestamp });
    const markup = renderToStaticMarkup(<ConversationMessage event={input} pendingRun={{ id: "pending-run", status: "RUNNING" }} />);
    expect(markup).toContain('aria-label="You message"');
    expect(markup).toContain("w-fit");
    expect(markup).toContain(`dateTime="${timestamp}"`);
    expect(markup).toContain('href="/runs/pending-run"');
    expect(markup).toContain("RUNNING");
    expect(markup).not.toContain('aria-label="Pending follow up"');
  });

  it.each(["", " \n\t "])("does not render an empty assistant bubble for %j", (text) => {
    const assistant = normalizeConversationEvent({ type: "assistant.message", data: { content: text } }, "source", 0)!;
    expect(renderToStaticMarkup(<ConversationMessage event={assistant} />)).toBe("");
  });
  it("renders user and assistant turns safely with separate identities", () => {
    const user = normalizeConversationEvent({ type: "user.message", data: { content: "**Next task**\n<script>bad()</script>" } }, "source", 0)!;
    const assistant = normalizeConversationEvent({ type: "assistant.message", data: { content: "Answer" } }, "source", 1)!;
    const markup = renderToStaticMarkup(<><ConversationMessage event={user} /><ConversationMessage event={assistant} /></>);
    expect(markup).toContain('aria-label="You message"');
    expect(markup).toContain('aria-label="Copilot message"');
    expect(markup).toContain("<strong>Next task</strong>");
    expect(markup).not.toContain("<script>");
  });

  it("keeps large tool activity collapsed until explicitly expanded", () => {
    const tool = normalizeConversationEvent({ type: "tool.execution_start", data: { toolName: "read_file", arguments: { path: "example.txt" } } }, "source", 2)!;
    const markup = renderToStaticMarkup(<ConversationMessage event={tool} />);
    expect(markup).toContain("<details");
    expect(markup).toContain("read_file");
    expect(markup).not.toContain("example.txt");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  });

  it("pairs a completed call into one compact row instead of keeping its Started state", () => {
    const start = normalizeConversationEvent({ type: "tool.execution_start", data: { toolName: "view", toolCallId: "read", arguments: { path: "example.txt" } } }, "source", 1)!;
    const result = normalizeConversationEvent({ type: "tool.execution_complete", data: { toolCallId: "read", success: true, result: "Private result" } }, "source", 2)!;
    const markup = renderToStaticMarkup(<ConversationMessage event={start} relatedEvents={[start, result]} />);
    expect(markup).toContain(">view</span>");
    expect(markup).not.toContain("Started");
    expect(markup).not.toContain("Private result");
    expect(markup.match(/<summary\b/g)).toHaveLength(1);
  });

  it.each([true, false])("shows live activity %s with metadata together and keeps completion initially closed", (live) => {
    const timeline = conversationTimeline([
      normalizeConversationEvent({ type: "tool.execution_start", data: { toolName: "rg", toolCallId: "query" } }, "source", 0)!,
      normalizeConversationEvent({ type: "session.usage_checkpoint" }, "source", 1)!,
    ]);
    const markup = renderToStaticMarkup(<ConversationTimelineEntries timeline={timeline} workId="work" isLive={live} />);
    const outer = markup.match(/<details[^>]*>/)?.[0] ?? "";
    expect(outer.includes('open=""')).toBe(live);
    expect(markup).toContain("Tools &amp; run details");
    expect(markup).toContain("1 tool ·");
    expect(markup).toContain("2 events");
    expect(markup).toContain(live ? "Running" : "Recorded");
    expect(markup).toContain("session.usage_checkpoint");
  });

  it("keeps a failed call visible in the collapsed group summary", () => {
    const timeline = conversationTimeline([
      normalizeConversationEvent({ type: "tool.execution_start", data: { toolName: "rg", toolCallId: "query" } }, "source", 0)!,
      normalizeConversationEvent({ type: "tool.execution_complete", data: { toolCallId: "query", success: false, result: "Full tool error" } }, "source", 1)!,
      normalizeConversationEvent({ type: "assistant.turn_end" }, "source", 2)!,
    ]);
    const markup = renderToStaticMarkup(<ConversationTimelineEntries timeline={timeline} workId="work" isLive={false} />);
    const summary = markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>"));
    expect(summary).toContain("text-red-400");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("Failed");
    expect(markup).not.toContain("Full tool error");
  });

  it("renders adjacent completed calls in one closed summary with each tool available inside", () => {
    const events = [
      { type: "tool.execution_complete", data: { toolCallId: "read", toolName: "view", success: true } },
      { type: "assistant.turn_end" },
      { type: "assistant.turn_start" },
      { type: "tool.execution_complete", data: { toolCallId: "search", toolName: "rg", success: true } },
      { type: "assistant.turn_end" },
    ].map((event, offset) => normalizeConversationEvent(event, "source", offset)!);
    const markup = renderToStaticMarkup(<ConversationTimelineEntries
      timeline={conversationTimeline(events)} workId="work" isLive={false} />);
    expect(markup.match(/class="work-activity-group\b/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<details class="work-activity-group[^>]*\sopen(?:=|\s|>)/);
    expect(markup).toContain("2 tools · 5 events · Completed");
    expect(markup.indexOf('title="view"')).toBeGreaterThan(markup.indexOf("2 tools"));
    expect(markup.indexOf('title="rg"')).toBeGreaterThan(markup.indexOf('title="view"'));
  });
});
import Link from "next/link";