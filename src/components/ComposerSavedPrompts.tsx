"use client";

import Link from "next/link";
import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookMarked, ListPlus, LoaderCircle, Plus, Search, Send, Settings2, X } from "lucide-react";
import {
  extractPromptTemplateApiError,
  filterSavedPrompts,
  MAX_PROMPT_TEMPLATE_CONTENT_LENGTH,
  type SavedPromptApplyMode,
  type SavedPromptTemplate,
} from "@/lib/prompt-templates";

export interface SavedPromptCreateForm {
  name: string;
  description: string;
  content: string;
}

export function computeSavedPromptsFloatingStyle(
  triggerRect: { top: number; bottom: number; left: number },
  viewportWidth: number,
  viewportHeight: number
): CSSProperties {
  const margin = 12;
  const width = Math.min(420, Math.max(240, viewportWidth - margin * 2));
  const left = Math.min(Math.max(margin, triggerRect.left), Math.max(margin, viewportWidth - width - margin));
  const spaceAbove = triggerRect.top - margin - 6;
  const spaceBelow = viewportHeight - triggerRect.bottom - margin - 6;
  const openUpward = spaceAbove >= 220 || spaceAbove >= spaceBelow;

  if (openUpward) {
    return {
      position: "fixed",
      left: `${Math.round(left)}px`,
      bottom: `${Math.max(margin, Math.round(viewportHeight - triggerRect.top + 6))}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.round(Math.min(400, Math.max(180, spaceAbove)))}px`,
      zIndex: 60,
    };
  }

  return {
    position: "fixed",
    left: `${Math.round(left)}px`,
    top: `${Math.max(margin, Math.round(triggerRect.bottom + 6))}px`,
    width: `${Math.round(width)}px`,
    maxHeight: `${Math.round(Math.min(400, Math.max(180, spaceBelow)))}px`,
    zIndex: 60,
  };
}

export interface SavedPromptsPanelProps {
  id: string;
  templates: SavedPromptTemplate[];
  loading: boolean;
  loadError: string | null;
  hasDraft: boolean;
  mode: SavedPromptApplyMode;
  searchQuery: string;
  creating: boolean;
  createForm: SavedPromptCreateForm;
  saving: boolean;
  saveError: string | null;
  savedNotice: string | null;
  canDirectSend: boolean;
  sendMode: "send" | "queue";
  targetLabel?: string;
  sendDisabledReason?: string | null;
  style?: CSSProperties;
  nameInputRef?: React.Ref<HTMLInputElement>;
  onModeChange: (mode: SavedPromptApplyMode) => void;
  onSearchChange: (query: string) => void;
  onRetryLoad: () => void;
  onSelectInsert: (template: SavedPromptTemplate) => void;
  onSelectSend: (template: SavedPromptTemplate) => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onCreateFormChange: (next: SavedPromptCreateForm) => void;
  onSavePrompt: () => void;
  onClose: () => void;
}

export function SavedPromptsPanel({
  id,
  templates,
  loading,
  loadError,
  hasDraft,
  mode,
  searchQuery,
  creating,
  createForm,
  saving,
  saveError,
  savedNotice,
  canDirectSend,
  sendMode,
  targetLabel,
  sendDisabledReason,
  style,
  nameInputRef,
  onModeChange,
  onSearchChange,
  onRetryLoad,
  onSelectInsert,
  onSelectSend,
  onStartCreate,
  onCancelCreate,
  onCreateFormChange,
  onSavePrompt,
  onClose,
}: SavedPromptsPanelProps) {
  const filtered = filterSavedPrompts(templates, searchQuery);
  const directSendTitle = !canDirectSend
    ? sendDisabledReason || "Direct send is unavailable right now. Click the prompt to insert into draft."
    : sendMode === "queue"
      ? targetLabel
        ? `Queue for ${targetLabel}`
        : hasDraft && mode === "append"
          ? "Append to draft and add to Queue"
          : "Add to Queue now"
      : targetLabel
        ? `Send to ${targetLabel}`
        : hasDraft && mode === "append"
          ? "Append to draft and send Follow Up"
          : "Send Follow Up now";

  return (
    <div
      id={id}
      role="dialog"
      aria-label="Saved prompts"
      style={style}
      className="saved-prompts-popover"
    >
      <div className="saved-prompts-header">
        <div className="saved-prompts-title">
          <BookMarked size={13} className="saved-prompts-icon" aria-hidden="true" />
          <span>Saved prompts</span>
          <span className="saved-prompts-count">{templates.length}</span>
        </div>
        <div className="saved-prompts-header-actions">
          {creating ? (
            <button type="button" onClick={onCancelCreate} disabled={saving} className="saved-prompts-header-button">
              <X size={12} aria-hidden="true" />
              Back
            </button>
          ) : (
            <button type="button" onClick={onStartCreate} className="saved-prompts-header-button">
              <Plus size={12} aria-hidden="true" />
              {hasDraft ? "Save draft" : "New"}
            </button>
          )}
          <Link href="/settings#prompt-templates" onClick={onClose} className="saved-prompts-header-link">
            <Settings2 size={12} aria-hidden="true" />
            Manage
          </Link>
        </div>
      </div>

      {savedNotice && (
        <p role="status" className="saved-prompts-notice">
          {savedNotice}
        </p>
      )}

      {creating ? (
        <div
          className="saved-prompts-create"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSavePrompt();
            }
          }}
        >
          <label className="saved-prompts-field">
            <span>Name</span>
            <input
              ref={nameInputRef}
              value={createForm.name}
              onChange={(event) => onCreateFormChange({ ...createForm, name: event.target.value })}
              placeholder="e.g. Case triage summary"
              maxLength={80}
              disabled={saving}
              className="ui-input w-full px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="saved-prompts-field">
            <span>Description (optional)</span>
            <input
              value={createForm.description}
              onChange={(event) => onCreateFormChange({ ...createForm, description: event.target.value })}
              placeholder="Optional short note"
              maxLength={240}
              disabled={saving}
              className="ui-input w-full px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="saved-prompts-field">
            <span>Prompt</span>
            <textarea
              value={createForm.content}
              onChange={(event) => onCreateFormChange({ ...createForm, content: event.target.value })}
              placeholder="Enter reusable prompt content..."
              rows={4}
              maxLength={MAX_PROMPT_TEMPLATE_CONTENT_LENGTH}
              disabled={saving}
              className="ui-input min-h-20 w-full resize-y px-2.5 py-1.5 font-mono text-xs leading-5"
            />
          </label>
          {saveError && (
            <p role="alert" className="text-xs text-red-400">
              {saveError}
            </p>
          )}
          <div className="saved-prompts-create-actions">
            <button type="button" onClick={onCancelCreate} disabled={saving} className="ui-secondary-button text-xs">
              Cancel
            </button>
            <button
              type="button"
              onClick={onSavePrompt}
              disabled={saving || !createForm.name.trim() || !createForm.content.trim()}
              className="ui-primary-button text-xs"
            >
              {saving ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
              {saving ? "Saving..." : "Save prompt"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {(templates.length > 5 || hasDraft) && (
            <div className="saved-prompts-controls">
              {templates.length > 5 && (
                <label className="saved-prompts-search">
                  <Search size={12} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Filter saved prompts"
                    value={searchQuery}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder="Filter saved prompts..."
                  />
                </label>
              )}
              {hasDraft && (
                <div className="saved-prompts-mode" role="group" aria-label="Draft apply mode">
                  {(["append", "replace"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={mode === option}
                      onClick={() => onModeChange(option)}
                      className="saved-prompts-mode-button"
                    >
                      {option === "append" ? "Append" : "Replace"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="saved-prompts-body">
            {loading && templates.length === 0 ? (
              <p className="saved-prompts-empty">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                Loading saved prompts...
              </p>
            ) : loadError && templates.length === 0 ? (
              <div role="alert" className="saved-prompts-error">
                <span>{loadError}</span>
                <button type="button" onClick={onRetryLoad} className="ui-secondary-button text-xs">
                  Retry
                </button>
              </div>
            ) : templates.length === 0 ? (
              <div className="saved-prompts-empty-state">
                <p>No saved prompts yet.</p>
                <button type="button" onClick={onStartCreate} className="ui-secondary-button text-xs">
                  <Plus size={13} aria-hidden="true" />
                  {hasDraft ? "Save current draft as prompt" : "Add saved prompt"}
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <p className="saved-prompts-empty">No saved prompts match &ldquo;{searchQuery.trim()}&rdquo;.</p>
            ) : (
              <ul className="saved-prompts-list" aria-label="Saved prompt templates">
                {filtered.map((template) => (
                  <li key={template.id} className="saved-prompts-item">
                    <button
                      type="button"
                      onClick={() => onSelectInsert(template)}
                      title={
                        hasDraft && mode === "append"
                          ? `Append "${template.name}" to draft`
                          : `Insert "${template.name}" into draft`
                      }
                      className="saved-prompts-insert-button"
                    >
                      <span className="saved-prompts-item-name">{template.name}</span>
                      <span className="saved-prompts-item-preview">{template.description || template.content}</span>
                    </button>
                    <button
                      type="button"
                      disabled={!canDirectSend}
                      onClick={() => onSelectSend(template)}
                      aria-label={`${sendMode === "queue" ? "Queue" : "Send"} saved prompt ${template.name}`}
                      title={directSendTitle}
                      className="saved-prompts-send-button"
                    >
                      {sendMode === "queue" ? (
                        <ListPlus size={12} aria-hidden="true" />
                      ) : (
                        <Send size={12} aria-hidden="true" />
                      )}
                      <span>{sendMode === "queue" ? "Queue" : "Send"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function ComposerSavedPrompts({
  draft,
  disabled,
  canDirectSend,
  sendMode,
  targetLabel,
  sendDisabledReason,
  onInsert,
  onSend,
}: {
  draft: string;
  disabled: boolean;
  canDirectSend: boolean;
  sendMode: "send" | "queue";
  targetLabel?: string;
  sendDisabledReason?: string | null;
  onInsert: (content: string, mode: SavedPromptApplyMode) => void;
  onSend: (content: string, mode: SavedPromptApplyMode) => void;
}) {
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverWrapperRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<SavedPromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<SavedPromptApplyMode>("append");
  const [searchQuery, setSearchQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<SavedPromptCreateForm>({ name: "", description: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>({});

  const hasDraft = draft.trim().length > 0;
  const isOpen = open && !disabled;
  const portalTarget = typeof document !== "undefined" ? document.body : null;

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === "undefined") return;
    setFloatingStyle(
      computeSavedPromptsFloatingStyle(
        trigger.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight
      )
    );
  }, []);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/prompt-templates", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body)) {
        throw new Error(extractPromptTemplateApiError(body, "Saved prompts are unavailable."));
      }
      setTemplates(
        body.map((item: SavedPromptTemplate) => ({
          id: item.id,
          name: item.name,
          description: item.description ?? null,
          content: item.content,
        }))
      );
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Saved prompts are unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  const closePopover = useCallback((restoreFocus = false) => {
    setOpen(false);
    setCreating(false);
    setSaveError(null);
    setSavedNotice(null);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        triggerRef.current?.focus({ preventScroll: true });
      });
    }
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleResizeOrScroll = () => updatePosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || popoverWrapperRef.current?.contains(target)) return;
      closePopover(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePopover(true);
      }
    };

    window.addEventListener("resize", handleResizeOrScroll);
    window.addEventListener("scroll", handleResizeOrScroll, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleResizeOrScroll);
      window.removeEventListener("scroll", handleResizeOrScroll, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, updatePosition, closePopover]);

  useEffect(() => {
    if (!isOpen || !creating) return;
    const frame = requestAnimationFrame(() => {
      nameInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, creating]);

  function startCreate() {
    setSavedNotice(null);
    setSaveError(null);
    setCreateForm({
      name: "",
      description: "",
      content: draft.trim(),
    });
    setCreating(true);
  }

  async function savePrompt() {
    const name = createForm.name.trim();
    const description = createForm.description.trim();
    const content = createForm.content;
    if (!name || !content.trim() || saving) return;

    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/prompt-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || undefined,
          content,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body.id !== "string") {
        throw new Error(extractPromptTemplateApiError(body, "Failed to save prompt."));
      }
      const created: SavedPromptTemplate = {
        id: body.id,
        name: body.name,
        description: body.description ?? null,
        content: body.content,
      };
      setTemplates((current) =>
        [...current, created].sort((left, right) => left.name.localeCompare(right.name))
      );
      setCreating(false);
      setCreateForm({ name: "", description: "", content: "" });
      setSavedNotice(`Saved "${created.name}"`);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Failed to save prompt.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        onClick={() => {
          if (isOpen) {
            closePopover(false);
          } else {
            setSavedNotice(null);
            setSaveError(null);
            setOpen(true);
            void fetchTemplates();
          }
        }}
        title="Insert or directly send a saved prompt template, or save a new prompt."
        className="work-toolbar-action inline-flex min-h-8 items-center gap-1 text-xs disabled:opacity-50"
      >
        <BookMarked size={14} aria-hidden="true" />
        Saved prompts
      </button>
      {isOpen &&
        portalTarget &&
        createPortal(
          <div ref={popoverWrapperRef}>
            <SavedPromptsPanel
              id={popoverId}
              templates={templates}
              loading={loading}
              loadError={loadError}
              hasDraft={hasDraft}
              mode={mode}
              searchQuery={searchQuery}
              creating={creating}
              createForm={createForm}
              saving={saving}
              saveError={saveError}
              savedNotice={savedNotice}
              canDirectSend={canDirectSend}
              sendMode={sendMode}
              targetLabel={targetLabel}
              sendDisabledReason={sendDisabledReason}
              style={floatingStyle}
              nameInputRef={nameInputRef}
              onModeChange={setMode}
              onSearchChange={setSearchQuery}
              onRetryLoad={() => void fetchTemplates()}
              onSelectInsert={(template) => {
                closePopover(false);
                onInsert(template.content, mode);
              }}
              onSelectSend={(template) => {
                closePopover(false);
                onSend(template.content, mode);
              }}
              onStartCreate={startCreate}
              onCancelCreate={() => {
                setCreating(false);
                setSaveError(null);
              }}
              onCreateFormChange={setCreateForm}
              onSavePrompt={() => void savePrompt()}
              onClose={() => closePopover(false)}
            />
          </div>,
          portalTarget
        )}
    </>
  );
}
