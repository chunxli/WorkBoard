"use client";

import { useState } from "react";
import { Check, FolderPlus, LoaderCircle, X } from "lucide-react";

export default function CreateFolderControl({
  parentPath,
  onCreated,
  onCancel,
}: {
  parentPath: string;
  onCreated: (path: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createFolder() {
    if (creating || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/fs/directories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath, name }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.path !== "string") {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to create folder"
        );
      }
      onCreated(body.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-neutral-800 bg-neutral-950/45 p-2">
      <FolderPlus size={14} className="ml-1 text-emerald-400" aria-hidden="true" />
      <input
        autoFocus
        value={name}
        maxLength={255}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void createFolder();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        placeholder="Folder name"
        aria-label="New folder name"
        className="min-h-8 min-w-0 rounded border border-neutral-700 bg-neutral-900 px-2.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-emerald-600"
      />
      <button
        type="button"
        onClick={() => void createFolder()}
        disabled={creating || !name.trim()}
        aria-label="Create folder"
        title="Create folder"
        className="grid size-8 place-items-center rounded bg-emerald-500 text-neutral-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {creating ? (
          <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <Check size={14} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={creating}
        aria-label="Cancel folder creation"
        title="Cancel"
        className="grid size-8 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-white disabled:opacity-40"
      >
        <X size={14} aria-hidden="true" />
      </button>
      {error && (
        <p role="alert" className="col-span-full px-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}