import { describe, expect, it, vi } from "vitest";
import {
  copyAssistantReply,
  markdownToBasicHtml,
  markdownToPlainText,
} from "./assistant-reply-copy";

describe("Assistant full-reply multi-format copy", () => {
  const sampleMarkdown = [
    "### 中文版",
    "",
    "**Symptoms（现象）：** 客户希望通过 [工单 2611270060000489](https://example.com/case) 访问 `21Vianet`。",
    "",
    "- 第一步：选择 **Verify and save**",
    "- 第二步：运行试点流水线",
    "",
    "```powershell",
    "az account show",
    "```",
  ].join("\n");

  it("copies exact raw Markdown when format is markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await copyAssistantReply({
      format: "markdown",
      markdown: sampleMarkdown,
      clipboard: { writeText },
    });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(sampleMarkdown);
  });

  it("strips Markdown formatting cleanly when format is plain text", async () => {
    const plain = markdownToPlainText(sampleMarkdown);
    expect(plain).toContain("中文版");
    expect(plain).toContain("Symptoms（现象）： 客户希望通过 工单 2611270060000489 (https://example.com/case) 访问 21Vianet。");
    expect(plain).toContain("- 第一步：选择 Verify and save");
    expect(plain).toContain("az account show");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("```");

    const writeText = vi.fn().mockResolvedValue(undefined);
    await copyAssistantReply({
      format: "text",
      markdown: sampleMarkdown,
      clipboard: { writeText },
    });
    expect(writeText).toHaveBeenCalledWith(plain);
  });

  it("writes both text/html and text/plain flavors when copying HTML, with writeText fallback", async () => {
    const html = markdownToBasicHtml(sampleMarkdown);
    expect(html).toContain("<h3>中文版</h3>");
    expect(html).toContain('<strong>Symptoms（现象）：</strong>');
    expect(html).toContain('<a href="https://example.com/case">工单 2611270060000489</a>');
    expect(html).toContain("<code>21Vianet</code>");
    expect(html).toContain("<ul><li>第一步：选择 <strong>Verify and save</strong></li><li>第二步：运行试点流水线</li></ul>");
    expect(html).toContain('<pre><code class="language-powershell">az account show</code></pre>');

    let capturedBlobs: Record<string, Blob> | null = null;
    const write = vi.fn().mockResolvedValue(undefined);
    await copyAssistantReply({
      format: "html",
      markdown: sampleMarkdown,
      clipboard: { write },
      createClipboardItem: (items) => {
        capturedBlobs = items;
        return items as unknown as ClipboardItem;
      },
    });
    expect(write).toHaveBeenCalledOnce();
    expect(await capturedBlobs!["text/html"].text()).toBe(`<div>${html}</div>`);
    expect(await capturedBlobs!["text/plain"].text()).toBe(html);

    // Falls back to writeText when clipboard.write fails or is absent
    const fallbackWriteText = vi.fn().mockResolvedValue(undefined);
    await copyAssistantReply({
      format: "html",
      markdown: sampleMarkdown,
      clipboard: {
        write: vi.fn().mockRejectedValue(new Error("ClipboardItem blocked")),
        writeText: fallbackWriteText,
      },
      createClipboardItem: (items) => items as unknown as ClipboardItem,
    });
    expect(fallbackWriteText).toHaveBeenCalledWith(html);
  });
});
