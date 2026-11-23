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

  it("adds documentation heading IDs only when requested, including inline text and duplicate names", () => {
    const content = "## 当前状态摘要\n\n## **Setup** `CLI`\n\n## Setup CLI\n\n```md\n## Not a heading\n```";
    const plain = renderToStaticMarkup(<MarkdownResult content={content} />);
    expect(plain).not.toContain('id="当前状态摘要"');
    const docs = renderToStaticMarkup(<MarkdownResult content={content} headingIds />);
    expect(docs).toContain('id="当前状态摘要"');
    expect(docs).toContain('id="setup-cli"');
    expect(docs).toContain('id="setup-cli-1"');
    expect(docs).not.toContain('id="not-a-heading"');
  });

  it("composes documentation link rendering with code-copy controls and safe URLs", () => {
    const markup = renderToStaticMarkup(<MarkdownResult
      content={'[Guide](caseiq-integration.md)\n\n[unsafe](javascript:alert(1))\n\n```powershell\nGet-Command gh\n```'}
      headingIds copyCodeBlocks components={{
        a: ({ children, href }) => <a href={href === "caseiq-integration.md" ? "/docs/caseiq" : href}>{children}</a>,
      }}
    />);
    expect(markup).toContain('href="/docs/caseiq"');
    expect(markup.match(/aria-label="Copy code"/g)).toHaveLength(1);
    expect(markup).not.toContain("javascript:");
  });
});