"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";

export function syncRuntimeBannerDisclosure(options: {
  disclosure: Pick<HTMLDetailsElement, "open"> | null;
  revealKey: string | null | undefined;
  autoCollapse: boolean;
  wasAutoOpened: boolean;
  wasAutoCollapsed: boolean;
}): { autoOpened: boolean; autoCollapsed: boolean } {
  const { disclosure, revealKey, autoCollapse, wasAutoOpened, wasAutoCollapsed } = options;
  let nextAutoOpened = wasAutoOpened;
  if (revealKey) {
    if (disclosure) {
      disclosure.open = true;
      nextAutoOpened = true;
    }
  } else if (autoCollapse && (!wasAutoCollapsed || nextAutoOpened)) {
    if (disclosure) disclosure.open = false;
    nextAutoOpened = false;
  }
  return { autoOpened: nextAutoOpened, autoCollapsed: autoCollapse };
}

export default function CaseIqAccessBanner({
  label,
  title,
  summary,
  busy,
  error,
  verified,
  revealKey,
  autoCollapse = false,
  children,
}: {
  label: string;
  title?: string;
  summary: string;
  busy: boolean;
  error: string | null;
  verified?: boolean;
  children: ReactNode;
  revealKey?: string | null;
  autoCollapse?: boolean;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const autoOpened = useRef(false);
  const autoCollapsed = useRef(autoCollapse);
  useEffect(() => {
    const synced = syncRuntimeBannerDisclosure({
      disclosure: disclosure.current,
      revealKey,
      autoCollapse,
      wasAutoOpened: autoOpened.current,
      wasAutoCollapsed: autoCollapsed.current,
    });
    autoOpened.current = synced.autoOpened;
    autoCollapsed.current = synced.autoCollapsed;
  }, [revealKey, autoCollapse]);
  const status = error ? "Needs attention" : summary;
  return <section aria-label={label} aria-busy={busy} className="runtime-access-banner">
    <details ref={disclosure} data-runtime-banner="" onToggle={() => {
      if (disclosure.current && !disclosure.current.open && !revealKey) {
        autoOpened.current = false;
      }
    }}>
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
