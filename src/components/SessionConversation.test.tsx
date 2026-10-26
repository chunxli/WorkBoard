import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SessionConversation, { ConversationActivityGroup, ConversationMessage } from "./SessionConversation";
import { normalizeConversationEvent } from "@/lib/session-conversation";
import { conversationTimeline } from "@/lib/conversation-activity";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("session conversation toolbar", () => {
  it("renders one labelled heading with its view switch and supplied Run actions above the unchanged log", () => {
    const markup = renderToStaticMarkup(<SessionConversation
      workId="layout-work" runId="layout-run" initialLog="" isLive={false}
      historySync={false} outputFormat="text"
      runActions={<Link href="/runs/layout-run">Full details</Link>}
    />);
    expect(markup.match(/<h2\b/g)).toHaveLength(1);
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
      workId="layout-work" runId={null} initialLog="" isLive={false}
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
      workId="workspace" runId="run" initialLog="" isLive={false} historySync={false} outputFormat="text"
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

describe("session conversation messages", () => {
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