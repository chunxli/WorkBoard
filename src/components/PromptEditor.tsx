"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, MessageSquareText, Play } from "lucide-react";
import PromptTemplatePicker from "@/components/PromptTemplatePicker";

interface ConflictState {
  content: string;
  hash: string;
}

export default function PromptEditor({
  workId,
  promptFileName,
  initialContent,
  initialHash,
  defaultEngine,
  hasActiveConflict,
  archived,
}: {
  workId: string;
  promptFileName: string;
  initialContent: string;
  initialHash: string;
  defaultEngine: "CLI" | "SDK";
  hasActiveConflict: boolean;
  archived: boolean;
}) {
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [state, setState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [engineOverride, setEngineOverride] = useState<"CLI" | "SDK" | null>(null);
  const [conflictMode, setConflictMode] = useState<"DIRECT" | "COPY_ON_CONFLICT">("DIRECT");
  const [starting, setStarting] = useState(false);
  const latestHashRef = useRef(initialHash);
  const latestContentRef = useRef(initialContent);
  const latestRequestedContentRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const engine = engineOverride ?? defaultEngine;

  const save = useCallback((nextContent: string, expectedHashOverride?: string): Promise<boolean> => {
    if (expectedHashOverride === undefined && latestRequestedContentRef.current === nextContent) {
      return saveQueueRef.current;
    }
    latestRequestedContentRef.current = nextContent;
    setState("saving");
    setMessage(null);
    const operation = saveQueueRef.current.catch(() => false).then(async () => {
      try {
        const response = await fetch(`/api/works/${workId}/prompt`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: nextContent,
            expectedHash: expectedHashOverride ?? latestHashRef.current,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 409 && body.code === "prompt_conflict") {
          setConflict({ content: body.currentContent, hash: body.currentHash });
          setState("conflict");
          return false;
        }
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Save failed");
        latestHashRef.current = body.hash;
        setSavedContent(nextContent);
        setConflict(null);
        if (nextContent === latestContentRef.current) setState("saved");
        return true;
      } catch (reason) {
        if (latestRequestedContentRef.current === nextContent) {
          latestRequestedContentRef.current = null;
          setState("error");
          setMessage(reason instanceof Error ? reason.message : String(reason));
        }
        return false;
      }
    });
    saveQueueRef.current = operation;
    return operation;
  }, [workId]);

  async function startRun() {
    setStarting(true);
    setMessage(null);
    try {
      if (content !== savedContent || state !== "saved") {
        const saved = await save(content);
        if (!saved) return;
      }
      const response = await fetch(`/api/works/${workId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine, conflictMode }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to start Work");
      }
      window.location.href = `/work/${workId}`;
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (content === savedContent || content === latestRequestedContentRef.current || conflict) return;
    const timer = setTimeout(() => void save(content), 600);
    return () => clearTimeout(timer);
  }, [content, conflict, save, savedContent]);

  const stateLabel =
    state === "saving" ? "Saving" : state === "saved" ? "Saved" : state === "conflict" ? "Conflict" : "Save failed";

  return (
    <section className="ui-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3.5 sm:px-5">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-md bg-neutral-800 text-neutral-300">
            <MessageSquareText size={16} aria-hidden="true" />
          </span>
          <div>
          <h2 className="text-sm font-bold">Prompt</h2>
          <p className="font-mono text-xs text-neutral-500">{promptFileName}</p>
          </div>
        </div>
        <span
          aria-live="polite"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase ${
            state === "error" || state === "conflict"
              ? "border-amber-900 bg-amber-950/50 text-amber-300"
              : state === "saving"
                ? "border-blue-900 bg-blue-950/50 text-blue-300"
                : "border-emerald-900 bg-emerald-950/50 text-emerald-300"
          }`}
        >
          {state === "saving" ? (
            <LoaderCircle size={11} className="animate-spin" aria-hidden="true" />
          ) : state === "saved" ? (
            <Check size={11} aria-hidden="true" />
          ) : (
            <AlertTriangle size={11} aria-hidden="true" />
          )}
          {stateLabel}
        </span>
      </div>
      <div className="space-y-3 p-4 sm:p-5">
      <PromptTemplatePicker
        value={content}
        onChange={(nextContent) => {
          latestContentRef.current = nextContent;
          setContent(nextContent);
        }}
      />
      <textarea
        value={content}
        onChange={(event) => {
          latestContentRef.current = event.target.value;
          setContent(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void save(content);
          }
        }}
        rows={18}
        spellCheck={false}
        className="min-h-96 w-full resize-y rounded-md border border-neutral-700 bg-neutral-950/90 p-4 font-mono text-sm leading-6 text-neutral-200 shadow-inner shadow-black/25 focus:border-emerald-700"
      />
      {message && <p role="alert" className="text-sm text-red-400">{message}</p>}
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-800 bg-amber-950/30 p-3 text-sm">
          <span>PROMPT was changed outside Work Board.</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setContent(conflict.content);
                latestContentRef.current = conflict.content;
                setSavedContent(conflict.content);
                latestHashRef.current = conflict.hash;
                latestRequestedContentRef.current = conflict.content;
                setConflict(null);
                setState("saved");
              }}
              className="rounded-md border border-amber-700 px-3 py-1.5 hover:bg-amber-900/50"
            >
              Reload disk version
            </button>
            <button
              type="button"
              onClick={() => void save(content, conflict.hash)}
              className="rounded-md bg-amber-400 px-3 py-1.5 font-bold text-[var(--on-accent)] hover:bg-amber-300"
            >
              Overwrite
            </button>
          </div>
        </div>
      )}
      {!archived && (
        <div className="flex flex-col justify-between gap-3 border-t border-neutral-800 pt-4 sm:flex-row sm:items-end">
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-neutral-500">
              Engine this run
              <select
                value={engine}
                onChange={(event) => setEngineOverride(event.target.value as "CLI" | "SDK")}
                className="ui-input mt-1.5 block px-3 py-2 text-sm"
              >
                <option value="CLI">Copilot CLI</option>
                <option value="SDK">Copilot SDK</option>
              </select>
            </label>
            {hasActiveConflict && (
              <label className="text-xs text-amber-400">
                Directory already active
                <select
                  value={conflictMode}
                  onChange={(event) =>
                    setConflictMode(event.target.value as "DIRECT" | "COPY_ON_CONFLICT")
                  }
                  className="mt-1.5 block min-h-10 rounded-md border border-amber-800 bg-neutral-950 px-3 py-2 text-sm text-white"
                >
                  <option value="DIRECT">Run here anyway</option>
                  <option value="COPY_ON_CONFLICT">Copy to numbered folder</option>
                </select>
              </label>
            )}
          </div>
          <button
            type="button"
            onClick={() => void startRun()}
            disabled={starting || state === "conflict"}
            className="ui-primary-button px-5"
          >
            <Play size={15} fill="currentColor" aria-hidden="true" />
            {starting ? "Starting..." : "Run Work"}
          </button>
        </div>
      )}
      </div>
    </section>
  );
}