"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, LoaderCircle, RefreshCw } from "lucide-react";
import { z } from "zod";

interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "unsupported";
}

const directoryPageSchema = z.object({
  entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(["directory", "file", "unsupported"]) })),
  nextOffset: z.number().int().nonnegative().nullable(),
});

function Directory({ workId, directory, version }: { workId: string; directory: string; version: number }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryOffset, setRetryOffset] = useState(0);

  const load = useCallback(async (offset: number, signal?: AbortSignal) => {
    const query = new URLSearchParams({ path: directory, offset: String(offset) });
    const response = await fetch(`/api/works/${encodeURIComponent(workId)}/files?${query}`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to list Work files");
    const parsed = directoryPageSchema.safeParse(body);
    if (!parsed.success) throw new Error("The server returned an invalid file listing.");
    return parsed.data;
  }, [directory, workId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(0, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setEntries(page.entries);
      setNextOffset(page.nextOffset);
      setError(null);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to list Work files");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load, version]);

  async function requestPage(offset: number) {
    setLoading(true);
    setError(null);
    setRetryOffset(offset);
    try {
      const page = await load(offset);
      setEntries((current) => offset === 0 ? page.entries : [...current, ...page.entries]);
      setNextOffset(page.nextOffset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to list Work files");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ul className="min-w-0 space-y-0.5" aria-label={directory ? `${directory} files` : "Work directory files"}>
      {entries.map((entry) => <li key={entry.path} className="min-w-0">
        {entry.kind === "directory" ? <>
          <button type="button" aria-expanded={open.has(entry.path)} title={entry.name}
            onClick={() => setOpen((current) => {
              const next = new Set(current);
              if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
              return next;
            })}
            className="flex min-h-8 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-xs text-neutral-300 hover:bg-neutral-800">
            {open.has(entry.path) ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
            <Folder size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{entry.name}</span>
          </button>
          {open.has(entry.path) && <div className="ml-3 border-l border-neutral-800 pl-1">
            <Directory key={entry.path} workId={workId} directory={entry.path} version={version} />
          </div>}
        </> : entry.kind === "file" ? <a
          href={`/api/works/${encodeURIComponent(workId)}/files?${new URLSearchParams({ path: entry.path, open: "1" })}`}
          target="_blank" rel="noopener noreferrer" title={`Open ${entry.name} in a new tab`}
          className="flex min-h-8 min-w-0 items-center gap-1.5 rounded px-1 pl-4 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-emerald-300">
          <File size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{entry.name}</span>
        </a> : <span className="block truncate px-1 py-1 pl-4 text-xs text-neutral-500" title="Special files and symbolic links are not exposed">
          {entry.name}
        </span>}
      </li>)}
      {loading && <li className="flex items-center gap-2 p-2 text-xs text-neutral-400"><LoaderCircle size={13} className="animate-spin" aria-hidden="true" />Loading files...</li>}
      {!loading && !error && entries.length === 0 && <li className="p-2 text-xs text-neutral-400">Empty folder.</li>}
      {error && <li role="alert" className="p-2 text-xs text-red-400">{error}
        <button type="button" className="ml-2 underline" onClick={() => requestPage(retryOffset)}>Retry</button>
      </li>}
      {nextOffset !== null && !loading && !error && <li><button type="button" className="p-2 text-xs text-emerald-400" onClick={() => requestPage(nextOffset)}>Load more files</button></li>}
    </ul>
  );
}

export default function WorkFileBrowser({ workId }: { workId: string }) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ workId: string }>).detail?.workId === workId) setVersion((current) => current + 1);
    };
    window.addEventListener("workboard:files-updated", refresh);
    return () => window.removeEventListener("workboard:files-updated", refresh);
  }, [workId]);
  return (
    <div className="work-file-browser flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-neutral-300">Work files</h2>
        <button type="button" title="Refresh files" aria-label="Refresh files" onClick={() => setVersion((current) => current + 1)}
          className="grid size-8 place-items-center rounded text-neutral-400 hover:bg-neutral-800">
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      <p className="text-[10px] text-neutral-400">Read-only · files open in a new tab</p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Directory key={workId} workId={workId} directory="" version={version} />
      </div>
    </div>
  );
}
