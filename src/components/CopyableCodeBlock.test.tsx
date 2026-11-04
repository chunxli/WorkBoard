import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CopyableCodeBlock, { copyCodeText } from "./CopyableCodeBlock";

describe("code clipboard transport", () => {
  it.each([
    "<sample value=\"a&b\">\n\t<item>Copy literal</item>\n</sample>\n",
    "  first\r\n\tsecond\r\n",
    "const text = '中文';\n",
    "",
  ])("copies the exact code without trimming or rewriting: %j", async (text) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await copyCodeText(text, { writeText });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  });

  it("reports clipboard unavailability rather than returning success", async () => {
    await expect(copyCodeText("code", undefined)).rejects.toThrow("Clipboard is unavailable");
  });

  it("propagates clipboard permission errors for the block's visible alert", async () => {
    const failure = new Error("Clipboard permission denied");
    await expect(copyCodeText("code", { writeText: vi.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
  });

  it("retains scroll/format classes and isolates the copy action from code contents", () => {
    const markup = renderToStaticMarkup(<CopyableCodeBlock className="max-h-96 overflow-auto whitespace-pre-wrap"><code>{"  <sample />\n"}</code></CopyableCodeBlock>);
    expect(markup).toContain('class="max-h-96 overflow-auto whitespace-pre-wrap"');
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain('type="button"');
    const button = markup.match(/<button\b[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(button).toContain("size-7");
    expect(button).toContain("[@media(pointer:coarse)]:size-11");
    expect(button).toContain("focus-visible:outline-2");
    expect(button).not.toContain("ui-secondary-button");
    expect(button).not.toContain("min-height:44px");
    expect(button).not.toMatch(/>(?:Copy|Copied)</);
    expect(markup).toContain("<code>  &lt;sample /&gt;\n</code>");
    expect(markup).toContain('role="status"');
  });
});
