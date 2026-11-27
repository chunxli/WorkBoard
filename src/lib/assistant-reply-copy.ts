export type AssistantReplyCopyFormat = "markdown" | "html" | "text";

export interface ClipboardWriterLike {
  writeText?: (text: string) => Promise<void>;
  write?: (items: ClipboardItem[]) => Promise<void>;
}

const INTERNAL_ATTRIBUTES = [
  "data-conversation-event",
  "data-conversation-line",
  "data-pin-active",
  "data-copyable-code-block",
  "tabindex",
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatInlineMarkdownToHtml(line: string): string {
  let html = escapeHtml(line);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>',
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return html;
}

export function markdownToBasicHtml(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^(`{3,}|~{3,})(\S*)\s*$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      blocks.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${formatInlineMarkdownToHtml(headingMatch[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(`<li>${formatInlineMarkdownToHtml(lines[index].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${formatInlineMarkdownToHtml(lines[index].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(`{3,}|~{3,})/.test(lines[index]) &&
      !/^#{1,6}\s+/.test(lines[index]) &&
      !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[index])
    ) {
      paragraphLines.push(formatInlineMarkdownToHtml(lines[index]));
      index += 1;
    }
    blocks.push(`<p>${paragraphLines.join("<br>")}</p>`);
  }

  return blocks.join("\n");
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");
}

export function markdownToPlainText(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceToken = "";

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceToken = fenceMatch[1];
        continue;
      }
      if (rawLine.startsWith(fenceToken)) {
        inFence = false;
        fenceToken = "";
        continue;
      }
    }
    if (inFence) {
      out.push(rawLine);
      continue;
    }

    if (/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(rawLine)) {
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(rawLine)) {
      out.push("");
      continue;
    }

    let line = rawLine
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^(\s*)[*+]\s+/, "$1- ");

    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => stripInlineMarkdown(cell.trim()))
        .join("\t");
      out.push(line);
      continue;
    }

    out.push(stripInlineMarkdown(line));
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeClonedMarkdownTree(markdownRoot: HTMLElement): HTMLElement {
  const clone = markdownRoot.cloneNode(true) as HTMLElement;

  clone
    .querySelectorAll('.conversation-line-pin, button, [role="status"], [role="alert"], [data-copy-exclude]')
    .forEach((node) => node.remove());

  clone.querySelectorAll("pre").forEach((pre) => {
    Array.from(pre.children).forEach((child) => {
      if (child.tagName.toLowerCase() !== "code" && !child.textContent?.trim()) {
        child.remove();
      }
    });
    const code = pre.querySelector("code");
    if (!code) return;
    const lineSpans = code.querySelectorAll(".conversation-code-line");
    if (lineSpans.length > 0) {
      const lines = Array.from(lineSpans).map((span) => {
        const text = span.textContent ?? "";
        return text === "\u00a0" ? "" : text;
      });
      code.textContent = lines.join("\n");
    }
  });

  const cleanElements = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
  for (const el of cleanElements) {
    for (const attr of INTERNAL_ATTRIBUTES) {
      el.removeAttribute(attr);
    }
    if (el.classList.contains("conversation-pinnable")) {
      el.classList.remove("conversation-pinnable");
      if (el.classList.length === 0) {
        el.removeAttribute("class");
      }
    }
  }

  return clone;
}

export function extractCleanAssistantHtmlFromDom(markdownRoot: HTMLElement): string {
  return sanitizeClonedMarkdownTree(markdownRoot).innerHTML.trim();
}

function serializeCleanNodeToPlainText(node: Node): string {
  if (node.nodeType === 3) {
    return node.nodeValue ?? "";
  }
  if (node.nodeType !== 1) return "";

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n";
  if (tag === "pre") {
    return `\n\n${(el.textContent ?? "").replace(/\n+$/, "")}\n\n`;
  }
  if (tag === "ul") {
    const items = Array.from(el.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((li) => `- ${serializeChildrenInline(li).trim()}`);
    return `\n\n${items.join("\n")}\n\n`;
  }
  if (tag === "ol") {
    const start = Number.parseInt(el.getAttribute("start") ?? "1", 10) || 1;
    const items = Array.from(el.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((li, idx) => `${start + idx}. ${serializeChildrenInline(li).trim()}`);
    return `\n\n${items.join("\n")}\n\n`;
  }
  if (tag === "table") {
    const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.querySelectorAll("th, td"))
        .map((cell) => serializeChildrenInline(cell).trim())
        .join("\t"),
    );
    return `\n\n${rows.join("\n")}\n\n`;
  }
  if (/^(?:p|h[1-6]|blockquote|div|section)$/.test(tag)) {
    return `\n\n${serializeChildrenInline(el).trim()}\n\n`;
  }
  return serializeChildrenInline(el);
}

function serializeChildrenInline(parent: Node): string {
  return Array.from(parent.childNodes).map(serializeCleanNodeToPlainText).join("");
}

export function extractCleanPlainTextFromDom(markdownRoot: HTMLElement): string {
  const cleanRoot = sanitizeClonedMarkdownTree(markdownRoot);
  return serializeChildrenInline(cleanRoot)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function copyAssistantReply({
  format,
  markdown,
  markdownRoot = null,
  clipboard,
  createClipboardItem = typeof ClipboardItem !== "undefined"
    ? (items) => new ClipboardItem(items)
    : undefined,
}: {
  format: AssistantReplyCopyFormat;
  markdown: string;
  markdownRoot?: HTMLElement | null;
  clipboard: ClipboardWriterLike | undefined;
  createClipboardItem?: (items: Record<string, Blob>) => ClipboardItem;
}): Promise<void> {
  if (!clipboard?.writeText && !clipboard?.write) {
    throw new Error("Clipboard is unavailable. Use HTTPS or localhost to copy.");
  }

  if (format === "markdown") {
    if (!clipboard.writeText) throw new Error("Clipboard text writing is unavailable.");
    await clipboard.writeText(markdown);
    return;
  }

  if (format === "text") {
    if (!clipboard.writeText) throw new Error("Clipboard text writing is unavailable.");
    const plainText = markdownRoot
      ? extractCleanPlainTextFromDom(markdownRoot)
      : markdownToPlainText(markdown);
    await clipboard.writeText(plainText);
    return;
  }

  const html = markdownRoot
    ? extractCleanAssistantHtmlFromDom(markdownRoot)
    : markdownToBasicHtml(markdown);

  if (clipboard.write && createClipboardItem && typeof Blob !== "undefined") {
    try {
      const item = createClipboardItem({
        "text/html": new Blob([`<div>${html}</div>`], { type: "text/html" }),
        "text/plain": new Blob([html], { type: "text/plain" }),
      });
      await clipboard.write([item]);
      return;
    } catch {
      if (!clipboard.writeText) {
        throw new Error("Unable to write HTML to clipboard.");
      }
    }
  }

  if (!clipboard.writeText) throw new Error("Clipboard writing is unavailable.");
  await clipboard.writeText(html);
}
