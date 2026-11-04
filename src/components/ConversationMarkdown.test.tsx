import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ConversationMarkdown from "./ConversationMarkdown";
import { ConversationPinsContext, ConversationPinsPanel } from "./ConversationPins";
import { normalizeConversationEvent } from "@/lib/session-conversation";

const eventId = `${"a".repeat(64)}:0`;
const pin = { id: "pin", sessionId: "session", eventId, line: 7, preview: "<child/>", timestamp: null, createdAt: "2026-11-03T00:00:00Z" };
const context = {
  pins: [pin], activePin: pin, loading: false, busy: false, error: null, notice: null,
  toggle: vi.fn(), navigate: vi.fn(), remove: vi.fn(), refresh: vi.fn(),
};
const event = (text: string) => normalizeConversationEvent({ type: "assistant.message", data: { content: text } }, "a".repeat(64), 0)!;

describe("precise conversation source-line Pins", () => {
  it("anchors paragraphs, headings, fenced code and indented code to their original source lines", () => {
    const text = "Introduction.\n\n# Section\n\n```xml\n<sample>\n<child/>\n</sample>\n```\n\n    first\n    second\n";
    const markup = renderToStaticMarkup(<ConversationPinsContext.Provider value={context}>
      <ConversationMarkdown event={event(text)} />
    </ConversationPinsContext.Provider>);
    const lines = [...markup.matchAll(/aria-label="(?:Pin|Unpin) output line (\d+)"/g)].map((match) => Number(match[1]));
    expect(lines).toEqual([1, 3, 6, 7, 8, 11, 12]);
    expect(markup).toContain(`data-conversation-event="${eventId}" data-conversation-line="7" data-pin-active="true"`);
    expect(markup).toContain('aria-label="Unpin output line 7" aria-pressed="true"');
    expect(markup.match(/aria-label="Copy code"/g)).toHaveLength(2);
    expect(markup).toContain('class="language-xml"');
  });

  it("keeps inline code unchanged, skips empty code lines and supports tilde fences and lists", () => {
    const text = "A paragraph with `inline`.\n\n~~~text\nfirst\n\nsecond\n~~~\n\n- list entry";
    const markup = renderToStaticMarkup(<ConversationPinsContext.Provider value={context}>
      <ConversationMarkdown event={event(text)} />
    </ConversationPinsContext.Provider>);
    expect(markup).toContain("<code>inline</code>");
    expect(markup).toContain('aria-label="Pin output line 4"');
    expect(markup).not.toContain('output line 5"');
    expect(markup).toContain('aria-label="Pin output line 6"');
    expect(markup).toContain('aria-label="Pin output line 9"');
  });

  it("does not enable Pins outside an available session context", () => {
    const markup = renderToStaticMarkup(<ConversationMarkdown event={event("```text\ncode\n```")} />);
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).not.toContain("output line");
  });

  it.each([
    ["    ```xml\n    literal\n    ```", [1, 2, 3]],
    ["> ```xml\n> <sample />\n> ```", [2]],
    ["- result:\n\n  ```xml\n  <sample />\n  ```", [1, 4]],
  ])("preserves exact source lines through indentation and nested Markdown: %j", (text, expected) => {
    const markup = renderToStaticMarkup(<ConversationPinsContext.Provider value={context}>
      <ConversationMarkdown event={event(String(text))} />
    </ConversationPinsContext.Provider>);
    const lines = [...markup.matchAll(/aria-label="(?:Pin|Unpin) output line (\d+)"/g)].map((match) => Number(match[1]));
    expect(lines).toEqual(expected);
  });

  it("places durable pin previews and distinct navigation/removal actions in the shelf", () => {
    const markup = renderToStaticMarkup(<ConversationPinsContext.Provider value={context}>
      <ConversationPinsPanel />
    </ConversationPinsContext.Provider>);
    expect(markup).toContain('aria-label="Conversation Pins"');
    expect(markup).toContain("Line 7");
    expect(markup).toContain('aria-label="Go to pinned line 7: &lt;child/&gt;"');
    expect(markup).toContain('aria-label="Remove Pin: &lt;child/&gt;"');
    expect(markup).not.toContain("<child/>");
  });

  it("keeps Pin errors explicit without replacing the saved list", () => {
    const markup = renderToStaticMarkup(<ConversationPinsContext.Provider value={{ ...context, error: "Source history changed." }}>
      <ConversationPinsPanel />
    </ConversationPinsContext.Provider>);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Source history changed.");
    expect(markup).toContain("Line 7");
  });
});
