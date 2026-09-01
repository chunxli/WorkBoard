"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import FolderBrowserModal from "@/components/FolderBrowserModal";

interface Shortcut {
  id: string;
  label: string;
  rootPath: string;
}

export default function WorkPathShortcutsSettings({ shortcuts }: { shortcuts: Shortcut[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/work-path-shortcuts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, rootPath }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Failed to save path");
      setLabel("");
      setRootPath("");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/work-path-shortcuts/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <form onSubmit={create} className="ui-panel grid gap-2 p-4 sm:grid-cols-[0.65fr_1.5fr_auto_auto]">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label"
          required
          className="ui-input px-3 py-2 text-sm"
        />
        <input
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
          placeholder="C:\\work"
          required
          className="ui-input px-3 py-2 font-mono text-sm"
        />
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          aria-label="Browse for shortcut path"
          title="Browse for path"
          className="ui-secondary-button"
        >
          <FolderOpen size={15} aria-hidden="true" />
          Browse
        </button>
        <button
          type="submit"
          disabled={busy}
          className="ui-primary-button"
        >
          <Plus size={15} aria-hidden="true" />
          Add
        </button>
      </form>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {browsing && (
        <FolderBrowserModal
          onClose={() => setBrowsing(false)}
          onSelect={(selected) => {
            setRootPath(selected);
            setBrowsing(false);
          }}
        />
      )}
      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/50">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.id} className="flex items-center justify-between gap-4 border-t border-neutral-800 px-4 py-3 first:border-0 hover:bg-neutral-800/30">
            <div className="min-w-0">
              <div className="text-sm font-medium">{shortcut.label}</div>
              <div className="truncate font-mono text-xs text-neutral-500">{shortcut.rootPath}</div>
            </div>
            <button
              type="button"
              onClick={() => void remove(shortcut.id)}
              aria-label={`Remove ${shortcut.label}`}
              title="Remove shortcut"
              className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-red-950/60 hover:text-red-300"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        {shortcuts.length === 0 && <p className="px-4 py-6 text-center text-sm text-neutral-500">No saved paths.</p>}
      </div>
    </div>
  );
}