import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownResult from "./MarkdownResult";

describe("MarkdownResult", () => {
  it("renders GitHub Flavored Markdown without enabling unsafe HTML", () => {
    const content = [
      "**Conclusion**",
      "",
      "- First",
      "- Second",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Status | Ready |",
      "",
      "<script>alert('unsafe')</script>",
      "",
      "[unsafe](javascript:alert('unsafe'))",
    ].join("\n");

    const markup = renderToStaticMarkup(<MarkdownResult content={content} />);

    expect(markup).toContain("<strong>Conclusion</strong>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<table>");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("javascript:");
  });
  it("keeps code-copy controls opt-in for other Markdown surfaces", () => {
    const content = "```xml\n<sample />\n```";
    const markup = renderToStaticMarkup(<MarkdownResult content={content} />);
    expect(markup).toContain("<pre><code");
    expect(markup).not.toContain('aria-label="Copy code"');
  });

  it.each([false, true])("adds one copy action per fenced/indented block with compact=%s, but not inline code", (compact) => {
    const content = "```xml\n<sample value=\"a&b\" />\n```\n\n    echo indented\n\n`inline code`";
    const markup = renderToStaticMarkup(<MarkdownResult content={content} compact={compact} copyCodeBlocks />);
    expect(markup.match(/aria-label="Copy code"/g)).toHaveLength(2);
    expect(markup).toContain('class="language-xml"');
    expect(markup).toContain("&lt;sample");
    expect(markup).toContain("echo indented");
    expect(markup).toContain("<code>inline code</code>");
  });

  it("does not create a copy action for inline-only code or enable unsafe HTML", () => {
    const markup = renderToStaticMarkup(<MarkdownResult content="`inline`\n\n<script>unsafe()</script>" copyCodeBlocks />);
    expect(markup).not.toContain('aria-label="Copy code"');
    expect(markup).not.toContain("<script>");
  });
});