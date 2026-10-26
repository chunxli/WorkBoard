"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  ArrowUp,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderRoot,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import CreateFolderControl from "@/components/CreateFolderControl";

export interface RootDirectoryOption {
  id: string;
  label: string;
  path: string;
  builtIn: boolean;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

const browseResponseSchema = z.object({
  current: z.string(),
  parent: z.string().nullable(),
  entries: z.array(z.object({ name: z.string(), path: z.string() })),
});

function comparablePath(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  return /^[a-z]:/i.test(trimmed) || trimmed.startsWith("\\\\")
    ? trimmed.toLowerCase()
    : trimmed;
}

function directoryName(value: string): string {
  return value.trim().split(/[\\/]/).filter(Boolean).pop() ?? "Root";
}

export default function RootDirectoryPicker({
  initialRoots,
  selectedPath,
  canOpenExplorer,
  onSelect,
}: {
  initialRoots: RootDirectoryOption[];
  selectedPath: string;
  canOpenExplorer: boolean;
  onSelect: (path: string) => void;
}) {
  const [roots, setRoots] = useState(initialRoots);
  const [rootPath, setRootPath] = useState(initialRoots[0]?.path ?? "");
  const [browsePath, setBrowsePath] = useState(initialRoots[0]?.path ?? "");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browseRequest = useRef(0);
  const selectedRoot = roots.find((root) => root.path === rootPath) ?? null;
  const shortcutPath = selectedPath.trim() || browsePath;
  const shortcutAlreadySaved = roots.some(
    (root) => comparablePath(root.path) === comparablePath(shortcutPath)
  );

  function navigateBrowser(nextPath: string) {
    browseRequest.current += 1;
    setBrowsePath(nextPath);
    setRefreshKey((current) => current + 1);
    setEntries([]);
    setParentPath(null);
    setError(null);
    setLoading(Boolean(nextPath));
  }

  useEffect(() => {
    if (!browsePath) {
      return;
    }
    const requestId = ++browseRequest.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetch(`/api/fs/browse?path=${encodeURIComponent(browsePath)}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          const body: unknown = await response.json();
          if (controller.signal.aborted || requestId !== browseRequest.current) return;
          if (!response.ok) {
            const failure = z.object({ error: z.string() }).safeParse(body);
            throw new Error(failure.success ? failure.data.error : "Failed to list directory");
          }
          const parsed = browseResponseSchema.safeParse(body);
          if (!parsed.success) throw new Error("The server returned invalid directory contents.");
          setEntries(parsed.data.entries);
          setParentPath(parsed.data.parent);
        })
        .catch((reason) => {
          if (controller.signal.aborted || requestId !== browseRequest.current) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          setEntries([]);
          setParentPath(null);
          setError(message);
        })
        .finally(() => {
          if (!controller.signal.aborted && requestId === browseRequest.current) setLoading(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [browsePath, refreshKey]);

  async function openExplorer(path: string) {
    setOpeningPath(path);
    setError(null);
    try {
      const response = await fetch("/api/fs/open-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to open Explorer");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpeningPath(null);
    }
  }

  async function saveCurrentRoot() {
    if (!shortcutPath) {
      setError("Select a directory first");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/work-path-shortcuts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: directoryName(shortcutPath),
          rootPath: shortcutPath,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to save root");
      }
      const saved: RootDirectoryOption = {
        id: body.id,
        label: body.label,
        path: body.rootPath,
        builtIn: false,
      };
      setRoots((current) => [saved, ...current]);
      setRootPath(saved.path);
      navigateBrowser(saved.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function removeRoot() {
    if (!selectedRoot || selectedRoot.builtIn) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/work-path-shortcuts/${selectedRoot.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to remove root");
      const remaining = roots.filter((root) => root.id !== selectedRoot.id);
      setRoots(remaining);
      const nextRootPath = remaining[0]?.path ?? "";
      setRootPath(nextRootPath);
      navigateBrowser(nextRootPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-md border border-neutral-800 bg-neutral-950/35">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 p-2">
        <FolderRoot size={15} className="ml-1 text-emerald-400" aria-hidden="true" />
        <select
          aria-label="Common root directory"
          value={rootPath}
          onChange={(event) => {
            setRootPath(event.target.value);
            navigateBrowser(event.target.value);
            setCreatingFolder(false);
          }}
          className="min-h-8 min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-300"
        >
          {roots.map((root) => (
            <option key={root.id} value={root.path}>{root.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => navigateBrowser(browsePath)}
          disabled={loading || !browsePath}
          aria-label="Refresh root directory"
          title="Refresh directory list"
          className="grid size-8 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-white disabled:opacity-40"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => setCreatingFolder((current) => !current)}
          disabled={!browsePath || loading}
          aria-label="Create folder in current directory"
          aria-expanded={creatingFolder}
          title="Create folder"
          className={`grid size-8 place-items-center rounded disabled:cursor-not-allowed disabled:opacity-40 ${
            creatingFolder
              ? "bg-emerald-950/60 text-emerald-300"
              : "text-neutral-500 hover:bg-neutral-800 hover:text-white"
          }`}
        >
          <FolderPlus size={14} aria-hidden="true" />
        </button>
        {canOpenExplorer && (
          <button
            type="button"
            onClick={() => void openExplorer(browsePath)}
            disabled={!browsePath || openingPath !== null}
            aria-label="Open current folder in Explorer"
            title="Open current folder in Windows Explorer"
            className="grid size-8 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-white disabled:opacity-40"
          >
            {openingPath === browsePath ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
          </button>
        )}
        {!selectedRoot?.builtIn && (
          <button
            type="button"
            onClick={() => void removeRoot()}
            disabled={saving}
            aria-label="Remove common root"
            title="Remove common root"
            className="grid size-8 place-items-center rounded text-neutral-500 hover:bg-red-950/60 hover:text-red-300 disabled:opacity-40"
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void saveCurrentRoot()}
          disabled={saving || !shortcutPath || shortcutAlreadySaved}
          aria-label="Add selected folder as common root"
          title={shortcutAlreadySaved ? "This folder is already a common root" : "Add selected folder as common root"}
          className="grid size-8 place-items-center rounded bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
        </button>
      </div>

      {creatingFolder && browsePath && (
        <CreateFolderControl
          parentPath={browsePath}
          onCancel={() => setCreatingFolder(false)}
          onCreated={(createdPath) => {
            setCreatingFolder(false);
            navigateBrowser(createdPath);
            onSelect(createdPath);
          }}
        />
      )}

      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-neutral-500">
        {parentPath && browsePath !== rootPath && (
          <button
            type="button"
            onClick={() => {
              navigateBrowser(parentPath);
              setCreatingFolder(false);
            }}
            aria-label="Go to parent folder"
            title="Go to parent folder"
            className="grid size-7 shrink-0 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <ArrowUp size={13} aria-hidden="true" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-mono" title={browsePath}>{browsePath || "No root selected"}</span>
        {browsePath && (
          <button
            type="button"
            onClick={() => onSelect(browsePath)}
            className="shrink-0 font-semibold text-emerald-400 hover:text-emerald-300"
          >
            Use current
          </button>
        )}
      </div>

      <div className="max-h-44 overflow-y-auto border-t border-neutral-800">
        {loading && (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-500">
            <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> Loading folders...
          </div>
        )}
        {!loading && entries.map((entry) => {
          const selected = selectedPath === entry.path;
          return (
            <div
              key={entry.path}
              className={`flex items-center gap-1 border-t border-neutral-800 px-2 py-1 first:border-0 ${selected ? "bg-emerald-950/40" : "hover:bg-neutral-900/70"}`}
            >
              <button
                type="button"
                onClick={() => onSelect(entry.path)}
                onDoubleClick={() => {
                  navigateBrowser(entry.path);
                  setCreatingFolder(false);
                }}
                title={entry.path}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left text-xs text-neutral-300"
              >
                <Folder size={14} className="shrink-0 text-emerald-500" aria-hidden="true" />
                <span className="truncate">{entry.name}</span>
              </button>
              {canOpenExplorer && (
                <button
                  type="button"
                  onClick={() => void openExplorer(entry.path)}
                  disabled={openingPath !== null}
                  aria-label={`Open ${entry.name} in Explorer`}
                  title="Open in Windows Explorer"
                  className="grid size-7 shrink-0 place-items-center rounded text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
                >
                  {openingPath === entry.path ? <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> : <FolderOpen size={13} aria-hidden="true" />}
                </button>
              )}
            </div>
          );
        })}
        {!loading && !error && entries.length === 0 && (
          <p className="px-3 py-4 text-xs text-neutral-500">No child directories.</p>
        )}
      </div>
      {error && <p role="alert" className="border-t border-red-900/50 px-3 py-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}