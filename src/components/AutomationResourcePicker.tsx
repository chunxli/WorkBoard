"use client";

import { useState } from "react";
import { Boxes, Check, FolderOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import FolderBrowserModal from "@/components/FolderBrowserModal";
import { inferResourceName, inferResourceSourceType } from "@/lib/resource-input";

export interface AutomationResource {
  id: string;
  name: string;
  sourceType: "LOCAL_PATH" | "GIT_URL";
  location: string;
  defaultBranch: string;
  hostname: string | null;
}

interface ResourceDraft {
  name: string;
  sourceType: "LOCAL_PATH" | "GIT_URL";
  location: string;
  defaultBranch: string;
}

const EMPTY_DRAFT: ResourceDraft = {
  name: "",
  sourceType: "LOCAL_PATH",
  location: "",
  defaultBranch: "main",
};

export default function AutomationResourcePicker({
  initialResources,
  value,
  onChange,
  initiallyEditing = false,
  showLabel = true,
  onEditorOpenChange,
}: {
  initialResources: AutomationResource[];
  value: string;
  onChange: (resourceId: string) => void;
  initiallyEditing?: boolean;
  showLabel?: boolean;
  onEditorOpenChange: (open: boolean) => void;
}) {
  const selected = initialResources.find((resource) => resource.id === value) ?? null;
  const initialMode = initialResources.length === 0 ? "create" : initiallyEditing ? "edit" : null;
  const [resources, setResources] = useState(initialResources);
  const [mode, setMode] = useState<"create" | "edit" | null>(initialMode);
  const [draft, setDraft] = useState<ResourceDraft>(
    initialMode === "edit" && selected
      ? {
          name: selected.name,
          sourceType: selected.sourceType,
          location: selected.location,
          defaultBranch: selected.defaultBranch,
        }
      : EMPTY_DRAFT
  );
  const [nameTouched, setNameTouched] = useState(false);
  const [sourceTypeTouched, setSourceTypeTouched] = useState(initialMode === "edit");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = resources.find((resource) => resource.id === value) ?? null;

  function changeMode(nextMode: "create" | "edit" | null) {
    setMode(nextMode);
    onEditorOpenChange(nextMode !== null);
  }

  function startCreate() {
    setDraft(EMPTY_DRAFT);
    setNameTouched(false);
    setSourceTypeTouched(false);
    setError(null);
    changeMode("create");
  }

  function startEdit() {
    if (!current) return;
    setDraft({
      name: current.name,
      sourceType: current.sourceType,
      location: current.location,
      defaultBranch: current.defaultBranch,
    });
    setNameTouched(true);
    setSourceTypeTouched(true);
    setError(null);
    changeMode("edit");
  }

  function updateLocation(location: string) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      location,
      sourceType: sourceTypeTouched
        ? currentDraft.sourceType
        : inferResourceSourceType(location),
      name: nameTouched ? currentDraft.name : inferResourceName(location),
    }));
  }

  async function detectLocation(location = draft.location) {
    if (!location.trim()) return;
    const response = await fetch("/api/repos/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location }),
    }).catch(() => null);
    if (!response?.ok) return;
    const detected = await response.json();
    setDraft((currentDraft) => ({
      ...currentDraft,
      sourceType: sourceTypeTouched
        ? currentDraft.sourceType
        : detected.sourceType ?? currentDraft.sourceType,
      defaultBranch: detected.defaultBranch ?? currentDraft.defaultBranch,
      name: nameTouched ? currentDraft.name : detected.name ?? currentDraft.name,
    }));
  }

  async function saveResource() {
    if (!draft.location.trim()) {
      setError("Resource location is required");
      return;
    }
    const name = draft.name.trim() || inferResourceName(draft.location);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        mode === "edit" && current ? `/api/repos/${current.id}` : "/api/repos",
        {
          method: mode === "edit" ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            sourceType: draft.sourceType,
            location: draft.location.trim(),
            defaultBranch: draft.defaultBranch.trim() || "main",
          }),
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to save resource");
      }
      const saved = body as AutomationResource;
      setResources((items) =>
        mode === "edit"
          ? items.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...items]
      );
      onChange(saved.id);
      changeMode(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteResource() {
    if (!current) return;
    const confirmed = window.confirm(
      `Delete "${current.name}"? Its linked automations and webhook configuration will also be deleted.`
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/repos/${current.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete resource");
      const remaining = resources.filter((resource) => resource.id !== current.id);
      setResources(remaining);
      onChange(remaining[0]?.id ?? "");
      if (remaining.length === 0) {
        setDraft(EMPTY_DRAFT);
        setNameTouched(false);
        setSourceTypeTouched(false);
        changeMode("create");
      } else {
        changeMode(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {showLabel && (
        <label className="text-xs font-medium text-neutral-400" htmlFor="automation-resource">
          Resource
        </label>
      )}
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Boxes
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
            aria-hidden="true"
          />
          <select
            id="automation-resource"
            aria-label="Resource"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              if (mode === "edit") changeMode(null);
            }}
            disabled={resources.length === 0}
            required
            className="ui-input w-full py-2 pl-9 pr-3 text-sm disabled:opacity-50"
          >
            {resources.length === 0 && <option value="">Create a resource below</option>}
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>{resource.name}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={startCreate}
          aria-label="New resource"
          title="New resource"
          className="grid size-10 shrink-0 place-items-center rounded-md border border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-white"
        >
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={startEdit}
          disabled={!current}
          aria-label="Edit selected resource"
          title="Edit selected resource"
          className="grid size-10 shrink-0 place-items-center rounded-md border border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      </div>
      {current && mode === null && (
        <p className="truncate font-mono text-[11px] text-neutral-600" title={current.location}>
          {current.location} · {current.defaultBranch}
        </p>
      )}

      {mode && (
        <div className="mt-3 border-t border-neutral-800 pt-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold text-neutral-300">
              {mode === "create" ? "New resource" : "Edit resource"}
            </span>
            <button
              type="button"
              onClick={() => changeMode(null)}
              disabled={resources.length === 0}
              aria-label="Close resource editor"
              title="Close"
              className="grid size-7 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-white disabled:hidden"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs text-neutral-500 sm:col-span-2">
              Location
              <div className="mt-1.5 flex gap-2">
                <input
                  value={draft.location}
                  onChange={(event) => updateLocation(event.target.value)}
                  onBlur={() => void detectLocation()}
                  placeholder="Local path or Git URL"
                  className="ui-input min-w-0 flex-1 px-3 py-2 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setBrowsing(true)}
                  aria-label="Browse for resource folder"
                  title="Browse for folder"
                  className="grid size-10 shrink-0 place-items-center rounded-md border border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-white"
                >
                  <FolderOpen size={15} aria-hidden="true" />
                </button>
              </div>
            </label>
            <label className="text-xs text-neutral-500">
              Name
              <input
                value={draft.name}
                onChange={(event) => {
                  setNameTouched(true);
                  setDraft({ ...draft, name: event.target.value });
                }}
                placeholder="Resource name"
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs text-neutral-500">
              Source type
              <select
                value={draft.sourceType}
                onChange={(event) => {
                  setSourceTypeTouched(true);
                  setDraft({
                    ...draft,
                    sourceType: event.target.value as "LOCAL_PATH" | "GIT_URL",
                  });
                }}
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
              >
                <option value="LOCAL_PATH">Local path</option>
                <option value="GIT_URL">Git URL</option>
              </select>
            </label>
            <label className="text-xs text-neutral-500">
              Default branch
              <input
                value={draft.defaultBranch}
                onChange={(event) => setDraft({ ...draft, defaultBranch: event.target.value })}
                placeholder="main"
                className="ui-input mt-1.5 w-full px-3 py-2 font-mono text-sm"
              />
            </label>
          </div>
          {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-neutral-800 pt-3">
            {mode === "edit" ? (
              <button
                type="button"
                onClick={() => void deleteResource()}
                disabled={busy}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                <Trash2 size={13} aria-hidden="true" />
                Delete
              </button>
            ) : <span />}
            <button
              type="button"
              onClick={() => void saveResource()}
              disabled={busy}
              className="ui-primary-button min-h-8 px-3 py-1.5 text-xs"
            >
              <Check size={13} aria-hidden="true" />
              {busy ? "Saving..." : mode === "create" ? "Add resource" : "Save resource"}
            </button>
          </div>
        </div>
      )}

      {browsing && (
        <FolderBrowserModal
          onClose={() => setBrowsing(false)}
          onSelect={(selectedPath) => {
            updateLocation(selectedPath);
            setBrowsing(false);
            void detectLocation(selectedPath);
          }}
        />
      )}
    </div>
  );
}