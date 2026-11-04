"use client";

import { isValidElement, useContext, useMemo, type ReactNode } from "react";
import type { Components, ExtraProps } from "react-markdown";
import type { ConversationEvent } from "@/lib/session-conversation";
import MarkdownResult from "@/components/MarkdownResult";
import CopyableCodeBlock from "@/components/CopyableCodeBlock";
import { ConversationLinePin, ConversationPinsContext } from "@/components/ConversationPins";

export default function ConversationMarkdown({ event, compact = false }: { event: ConversationEvent; compact?: boolean }) {
  const context = useContext(ConversationPinsContext);
  const activePin = context?.activePin;
  const components = useMemo<Components>(() => {
    const active = (line: number) => activePin?.eventId === event.id && activePin.line === line;
    const block = (Tag: "p" | "h1" | "h2" | "h3" | "h4" | "li") => function Block({ node, children }: ExtraProps & { children?: ReactNode }) {
      const line = node?.position?.start.line;
      const nestedParagraph = Tag === "li" && node?.children.some((child) => child.type === "element" && child.tagName === "p");
      if (!line || nestedParagraph) return <Tag>{children}</Tag>;
      return <Tag className="conversation-pinnable" data-conversation-event={event.id} data-conversation-line={line}
        data-pin-active={active(line) || undefined} tabIndex={-1}>
        {children}<ConversationLinePin eventId={event.id} line={line} />
      </Tag>;
    };
    return {
      p: block("p"), h1: block("h1"), h2: block("h2"), h3: block("h3"), h4: block("h4"), li: block("li"),
      pre: ({ node, children }) => {
        if (!isValidElement<{ children: ReactNode; className?: string }>(children) || typeof children.props.children !== "string" || !node?.position) {
          return <CopyableCodeBlock>{children}</CopyableCodeBlock>;
        }
        const text = children.props.children;
        const source = event.text.split(/\r\n|\n|\r/)[node.position.start.line - 1] ?? "";
        const fenced = /^(`{3,}|~{3,})/.test(source.slice(node.position.start.column - 1));
        const firstLine = node.position.start.line + Number(fenced);
        const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
        return <CopyableCodeBlock codeText={text}>
          <code className={children.props.className}>{lines.map((text, index) => {
            const line = firstLine + index;
            return <span key={line} className="conversation-code-line" data-conversation-event={event.id}
              data-conversation-line={line} data-pin-active={active(line) || undefined} tabIndex={-1}>
              {text || "\u00a0"}{text.trim() && <ConversationLinePin eventId={event.id} line={line} />}
            </span>;
          })}</code>
        </CopyableCodeBlock>;
      },
    };
  }, [event, activePin]);
  return <MarkdownResult content={event.text} compact={compact} copyCodeBlocks components={context ? components : undefined} />;
}
