"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";

export async function copyCodeText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined): Promise<void> {
  if (!clipboard?.writeText) throw new Error("Clipboard is unavailable. Use HTTPS or localhost to copy code.");
  await clipboard.writeText(text);
}

export default function CopyableCodeBlock({ children, className, codeText }: { children: ReactNode; className?: string; codeText?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    if (copying) return;
    setCopying(true);
    setCopied(false);
    setError(null);
    if (timer.current !== null) clearTimeout(timer.current);
    try {
      const text = codeText ?? pre.current?.querySelector("code")?.textContent;
      if (typeof text !== "string") throw new Error("Unable to find the code content.");
      await copyCodeText(text, navigator.clipboard);
      if (!mounted.current) return;
      setCopied(true);
      timer.current = setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, 1500);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Unable to copy code.");
    } finally {
      if (mounted.current) setCopying(false);
    }
  }

  return <>
    <pre ref={pre} className={className} data-copyable-code-block>
      <span className="sticky left-0 top-0 z-10 mb-1 flex justify-end whitespace-normal">
        <button type="button" aria-label="Copy code" title={copied ? "Code copied" : "Copy code"}
          disabled={copying} aria-busy={copying} onClick={() => void copy()}
          className="grid size-7 shrink-0 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:size-11">
          {copying ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            : copied ? <Check size={13} className="text-emerald-400" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
        <span role="status" className="sr-only">{copied ? "Code copied" : ""}</span>
      </span>
      {children}
    </pre>
    {error && <p role="alert" className="text-xs text-red-400">Could not copy code: {error}</p>}
  </>;
}
