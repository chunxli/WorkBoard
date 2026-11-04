import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionConversation, { conversationControlCapabilities, ConversationActivityGroup, ConversationMessage, handleConversationComposerKeyDown, handleConversationHistoryWheel, readEarlierConversationPages } from "./SessionConversation";
import { normalizeConversationEvent, type ConversationEvent } from "@/lib/session-conversation";
import { conversationTimeline, withPendingFollowUp } from "@/lib/conversation-activity";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("session conversation toolbar", () => {
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
    const activity = conversationTimeline([
      normalizeConversationEvent({ type: "tool.execution_start", data: { toolName: "rg", toolCallId: "query" } }, "source", 0)!,
      normalizeConversationEvent({ type: "session.usage_checkpoint" }, "source", 1)!,
    ])[0];
    if (activity.kind !== "activity") throw new Error("Expected activity");
    const markup = renderToStaticMarkup(<ConversationActivityGroup activity={activity} live={live} />);
    const outer = markup.match(/<details[^>]*>/)?.[0] ?? "";
    expect(outer.includes('open=""')).toBe(live);
    expect(markup).toContain("Tools &amp; run details");
    expect(markup).toContain("1 tool ·");
    expect(markup).toContain("2 events");
    expect(markup).toContain(live ? "Running" : "Recorded");
    expect(markup).toContain("session.usage_checkpoint");
  });

  it("keeps a failed call visible in the collapsed group summary", () => {
    const activity = conversationTimeline([
      normalizeConversationEvent({ type: "tool.execution_start", data: { toolName: "rg", toolCallId: "query" } }, "source", 0)!,
      normalizeConversationEvent({ type: "tool.execution_complete", data: { toolCallId: "query", success: false, result: "Full tool error" } }, "source", 1)!,
      normalizeConversationEvent({ type: "assistant.turn_end" }, "source", 2)!,
    ])[0];
    if (activity.kind !== "activity") throw new Error("Expected activity");
    const markup = renderToStaticMarkup(<ConversationActivityGroup activity={activity} live={false} />);
    const summary = markup.slice(markup.indexOf("<summary"), markup.indexOf("</summary>"));
    expect(summary).toContain("text-red-400");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("Failed");
    expect(markup).not.toContain("Full tool error");
  });
});
import Link from "next/link";