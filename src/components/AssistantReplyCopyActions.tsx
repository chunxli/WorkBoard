"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import {
  copyAssistantReply,
  type AssistantReplyCopyFormat,
} from "@/lib/assistant-reply-copy";

const FORMAT_OPTIONS: readonly {
  format: AssistantReplyCopyFormat;
  label: string;
  ariaLabel: string;
  title: string;
  showCopyIcon?: boolean;
}[] = [
  {
    format: "html",
    label: "Copy",
    ariaLabel: "Copy full reply as HTML",
    title: "Copy full reply (HTML rich text)",
    showCopyIcon: true,
  },
  {
    format: "markdown",
    label: "MD",
    ariaLabel: "Copy full reply as Markdown",
    title: "Copy full reply as Markdown",
  },
  {
    format: "text",
    label: "Text",
    ariaLabel: "Copy full reply as plain text",
    title: "Copy full reply as plain text",
  },
];

export default function AssistantReplyCopyActions({
  markdown,
  containerRef,
}: {
  markdown: string;
  containerRef?: RefObject<HTMLElement | null>;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const [copyingFormat, setCopyingFormat] = useState<AssistantReplyCopyFormat | null>(null);
  const [copiedFormat, setCopiedFormat] = useState<AssistantReplyCopyFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy(format: AssistantReplyCopyFormat) {
    if (copyingFormat !== null) return;
    setCopyingFormat(format);
    setCopiedFormat(null);
    setError(null);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    try {
      const markdownRoot =
        containerRef?.current?.querySelector<HTMLElement>(".markdown-result") ?? null;
      await copyAssistantReply({
        format,
        markdown,
        markdownRoot,
        clipboard: navigator.clipboard,
      });
      if (!mountedRef.current) return;
      setCopiedFormat(format);
      timerRef.current = setTimeout(() => {
        if (mountedRef.current) setCopiedFormat(null);
        timerRef.current = null;
      }, 1600);
    } catch (failure) {
      if (mountedRef.current) {
        setError(failure instanceof Error ? failure.message : "Unable to copy reply.");
      }
    } finally {
      if (mountedRef.current) setCopyingFormat(null);
    }
  }

  const copiedOption = FORMAT_OPTIONS.find((item) => item.format === copiedFormat);

  return (
    <div className="assistant-reply-copy-footer" data-copy-exclude="">
      <div className="assistant-reply-copy-group" role="group" aria-label="Copy full reply">
        {FORMAT_OPTIONS.map((option) => {
          const isCopying = copyingFormat === option.format;
          const isCopied = copiedFormat === option.format;
          return (
            <button
              key={option.format}
              type="button"
              aria-label={option.ariaLabel}
              title={isCopied ? (option.format === "html" ? "Copied as HTML" : `Copied as ${option.label}`) : option.title}
              disabled={copyingFormat !== null}
              aria-busy={isCopying || undefined}
              data-copied={isCopied || undefined}
              onClick={() => void handleCopy(option.format)}
              className="assistant-reply-copy-button"
            >
              {isCopying ? (
                <LoaderCircle size={10} className="animate-spin" aria-hidden="true" />
              ) : isCopied ? (
                <Check size={10} aria-hidden="true" />
              ) : option.showCopyIcon ? (
                <Copy size={10} aria-hidden="true" />
              ) : null}
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
      <span role="status" className="sr-only">
        {copiedOption ? `Copied full reply (${copiedOption.format === "html" ? "HTML" : copiedOption.label})` : ""}
      </span>
      {error && (
        <p role="alert" className="text-[11px] text-red-400">
          Could not copy reply: {error}
        </p>
      )}
    </div>
  );
}
