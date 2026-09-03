"use client";

import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, MessageSquarePlus, RotateCcw, X } from "lucide-react";
import { useRouter } from "next/navigation";

export default function FollowUpDialog({
  workId,
  mode,
  disabledReason,
}: {
  workId: string;
  mode: "resume" | "new";
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const titleId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portalTarget = typeof document === "undefined" ? null : document.body;

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = setTimeout(() => textareaRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dialogRef.current?.getAttribute("aria-busy") !== "true") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      trigger?.focus();
    };
  }, [open]);

  function close() {
    if (!submitting) setOpen(false);
  }

  async function submit() {
    const followUpPrompt = prompt.trim();
    if (!followUpPrompt) {
      setError("Enter a Follow Up prompt");
      textareaRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/works/${workId}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: followUpPrompt }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.runId !== "string") {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to start Follow Up");
      }
      router.push(`/runs/${body.runId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={Boolean(disabledReason)}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        title={disabledReason ?? "Send a new prompt to this Work session"}
        className="ui-primary-button disabled:cursor-not-allowed"
      >
        <MessageSquarePlus size={15} aria-hidden="true" />
        Follow Up
      </button>

      {open && portalTarget && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:items-center sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            aria-busy={submitting}
            className="ui-panel flex max-h-[calc(100dvh-1.5rem)] w-full max-w-xl flex-col overflow-hidden shadow-2xl shadow-black/45 sm:max-h-[calc(100dvh-3rem)]"
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3.5 sm:px-5">
              <div>
                <h2 id={titleId} className="flex items-center gap-2 text-sm font-bold text-neutral-100">
                  <MessageSquarePlus size={16} className="text-emerald-400" aria-hidden="true" />
                  Follow Up
                </h2>
                <p id={descriptionId} className="mt-1 text-xs text-neutral-500">
                  {mode === "resume"
                    ? "Resume the latest Work session and send a new prompt."
                    : "Start a new Work session with this prompt."}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                aria-label="Close Follow Up dialog"
                title="Close"
                className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-white disabled:opacity-40"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5">
              <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/45 px-3 py-2 text-xs text-neutral-400">
                {mode === "resume" ? (
                  <RotateCcw size={14} className="text-emerald-400" aria-hidden="true" />
                ) : (
                  <MessageSquarePlus size={14} className="text-emerald-400" aria-hidden="true" />
                )}
                {mode === "resume" ? "Resume latest session" : "Start new session"}
              </div>
              <label className="block text-xs font-semibold text-neutral-300">
                New prompt
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  disabled={submitting}
                  rows={8}
                  placeholder="Continue the analysis, refine the result, or ask for the next action..."
                  className="ui-input mt-2 min-h-44 w-full resize-y px-3 py-3 font-mono text-sm leading-6"
                />
              </label>
              <p className="text-xs leading-5 text-neutral-500">
                This prompt is appended to PROMPT.md and saved as a separate Follow Up Run.
              </p>
              {error && <p role="alert" className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">{error}</p>}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-950/30 px-4 py-3 sm:px-5">
              <span aria-live="polite" className="text-xs text-neutral-500">
                {submitting ? "Starting Follow Up..." : "Ctrl/Cmd + Enter to send"}
              </span>
              <div className="flex gap-2">
                <button type="button" onClick={close} disabled={submitting} className="ui-secondary-button">
                  Cancel
                </button>
                <button type="button" onClick={() => void submit()} disabled={submitting || !prompt.trim()} className="ui-primary-button">
                  {submitting ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <MessageSquarePlus size={15} aria-hidden="true" />}
                  {submitting ? "Starting..." : "Send Follow Up"}
                  {!submitting && <ArrowRight size={14} aria-hidden="true" />}
                </button>
              </div>
            </div>
          </div>
        </div>,
        portalTarget
      )}
    </>
  );
}
