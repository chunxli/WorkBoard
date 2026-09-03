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
});