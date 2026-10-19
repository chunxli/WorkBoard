import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationMessage } from "./SessionConversation";
import { normalizeConversationEvent } from "@/lib/session-conversation";

describe("session conversation messages", () => {
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
});