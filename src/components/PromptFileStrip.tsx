"use client";

import { FileText, Folder, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import { z } from "zod";

export const promptDirectoryResponseSchema = z.object({
  current: z.string(),
  items: z.array(z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(["directory", "file", "reference"]),
  })),
});

export interface PromptDirectoryState {
  current: string;
  items: z.infer<typeof promptDirectoryResponseSchema>["items"];
  loading: boolean;
  error: string | null;
}

export default function PromptFileStrip({
  directory,
  disabled,
  error,
  onInsert,
  onRefresh,
}: {
  directory: PromptDirectoryState;
  disabled: boolean;
  error: string | null;
  onInsert: (name: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="min-w-0 space-y-1" aria-label="Prompt file references">
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-500">
        <span className="shrink-0">Selected directory</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={directory.current}>{directory.current || "No directory selected"}</span>
        <button type="button" onClick={onRefresh} disabled={disabled || directory.loading || !directory.current}
          aria-label="Refresh selected directory" title="Refresh selected directory contents"
          className="grid size-6 shrink-0 place-items-center rounded hover:bg-neutral-800 hover:text-neutral-300 disabled:opacity-40 [@media(pointer:coarse)]:size-11">
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
      <div role="group" aria-label="Selected directory names" aria-busy={directory.loading}
        className="flex min-w-0 items-center gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {directory.loading ? (
          <p role="status" className="flex items-center gap-1.5 py-1 text-xs text-neutral-500">
            <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />Loading names...
          </p>
        ) : directory.error ? (
          <p role="alert" className="py-1 text-xs text-red-400">{directory.error} Refresh the selected directory to retry.</p>
        ) : !directory.current ? (
          <p className="py-1 text-xs text-neutral-500">Select a Work directory to list its contents.</p>
        ) : directory.items.length === 0 ? (
          <p className="py-1 text-xs text-neutral-500">This directory is empty.</p>
        ) : directory.items.map((item) => (
          <button key={item.path} type="button" disabled={disabled}
            aria-label={`Insert ${item.name} into Prompt`}
            title={`${item.path}${item.kind === "reference" ? " (name reference only)" : ""}`}
            onClick={() => onInsert(item.name)}
            className="flex min-h-8 max-w-56 shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-neutral-800 bg-neutral-950/35 px-2 text-[11px] text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:min-h-11">
            {item.kind === "directory" ? <Folder size={13} className="shrink-0 text-emerald-500" aria-hidden="true" />
              : item.kind === "file" ? <FileText size={13} className="shrink-0 text-neutral-500" aria-hidden="true" />
                : <Link2 size={13} className="shrink-0 text-neutral-500" aria-hidden="true" />}
            <span className="truncate">{item.name}</span>
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
