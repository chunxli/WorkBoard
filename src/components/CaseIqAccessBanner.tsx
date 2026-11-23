"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";

export default function CaseIqAccessBanner({ label, title, summary, busy, error, verified, revealKey, children }: {
  label: string; title?: string; summary: string; busy: boolean; error: string | null; verified?: boolean; children: ReactNode;
  revealKey?: string | null;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (revealKey && disclosure.current) disclosure.current.open = true;
  }, [revealKey]);
  const status = error ? "Needs attention" : summary;
  return <section aria-label={label} aria-busy={busy} className="runtime-access-banner">
    <details ref={disclosure} data-runtime-banner="">
      <summary aria-label={`Toggle ${label}`} className="runtime-access-summary">
        <ChevronRight size={12} className="runtime-access-chevron shrink-0" aria-hidden="true" />
        <strong className="runtime-access-title">{title ?? label}</strong>
        <span aria-live="polite" className="runtime-access-status" title={status}
          data-tone={error ? "error" : verified ? "verified" : "neutral"}>
          {status}
        </span>
        {busy && <RefreshCw size={12} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      </summary>
      <div className="runtime-access-body">{children}</div>
    </details>
  </section>;
}
