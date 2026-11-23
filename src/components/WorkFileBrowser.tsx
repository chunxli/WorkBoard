"use client";

import { useCallback, useContext, useEffect, useId, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, File, Folder, LoaderCircle, MessageSquarePlus, RefreshCw } from "lucide-react";
import { z } from "zod";
import { FollowUpComposerContext } from "@/components/FollowUpComposerContext";
import { pairedLaneInfo } from "@/lib/work-session-pair";
import { WorkFileNavigationContext, useWorkFileLocations, workFileLocations, type WorkFileLocation } from "@/components/WorkFileNavigationContext";

interface FileEntry {
  name: string;
  path: string;
  absolutePath: string | null;
  kind: "directory" | "file" | "unsupported";
}

export const directoryPageSchema = z.object({
  entries: z.array(z.object({
    name: z.string(), path: z.string(), absolutePath: z.string().min(1).nullable(), kind: z.enum(["directory", "file", "unsupported"]),
  }).refine((entry) => entry.kind === "unsupported" || entry.absolutePath !== null, "An ordinary file or folder requires an absolute path.")),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export function WorkPathReferenceButton({ workId, name, absolutePath }: { workId: string; name: string; absolutePath: string | null }) {
  const composer = useContext(FollowUpComposerContext);
  const available = composer?.workId === workId && !composer.disabled && absolutePath !== null;
  return <button type="button" aria-label={`Insert ${name} path into Follow Up`}
    title={available ? `Insert ${absolutePath} into Follow Up` : "The Follow Up draft is not available for editing."}
    disabled={!available} onClick={() => {
      if (available) composer.insertPath(absolutePath);
    }}
    className="grid size-8 shrink-0 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:size-11">
    <MessageSquarePlus size={13} aria-hidden="true" />
  </button>;
}

type PageRequest = { version: number; offset: number };
type LoadedDirectory = {
  version: number;
  request: PageRequest | null;
  entries: FileEntry[];
  nextOffset: number | null;
  error: string | null;
};

function Directory({ workId, directory, version, active = true, label, emptyMessage = "Empty folder." }: {
  workId: string;
  directory: string;
  version: number;
  active?: boolean;
  label?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [request, setRequest] = useState<PageRequest | null>(null);
  const [loaded, setLoaded] = useState<LoadedDirectory | null>(null);
  const currentRequest = request?.version === version ? request : null;
  const loading = loaded?.version !== version || loaded.request !== currentRequest;
  const entries = loaded?.entries ?? [];
  const error = !loading && loaded ? loaded.error : null;
  const nextOffset = loaded?.nextOffset ?? null;

  const load = useCallback(async (offset: number, signal: AbortSignal) => {
    const query = new URLSearchParams({ path: directory, offset: String(offset) });
    const response = await fetch(`/api/works/${encodeURIComponent(workId)}/files?${query}`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to list Work files");
    const parsed = directoryPageSchema.safeParse(body);
    if (!parsed.success) throw new Error("The server returned an invalid file listing.");
    return parsed.data;
  }, [directory, workId]);

  useEffect(() => {
    if (!active || !loading) return;
    const controller = new AbortController();
    const offset = currentRequest?.offset ?? 0;
    void load(offset, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setLoaded((previous) => ({
        version, request: currentRequest, error: null, nextOffset: page.nextOffset,
        entries: offset !== 0 && previous?.version === version ? [...previous.entries, ...page.entries] : page.entries,
      }));
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setLoaded((previous) => ({
        version, request: currentRequest, nextOffset: null,
        entries: offset !== 0 && previous?.version === version ? previous.entries : [],
        error: reason instanceof Error ? reason.message : "Unable to list Work files",
      }));
    });
    return () => controller.abort();
  }, [active, currentRequest, load, loading, version]);

  function requestPage(offset: number) {
    setRequest({ version, offset });
  }

  return (
    <ul className="min-w-0 space-y-0.5" aria-label={label ?? (directory ? `${directory} files` : "Work directory files")} aria-busy={loading}>
      {entries.map((entry) => <li key={entry.path} className="min-w-0">
        {entry.kind === "directory" ? <>
          <div className="flex min-w-0 items-center gap-1">
          <button type="button" aria-expanded={open.has(entry.path)} title={entry.name}
            onClick={() => setOpen((current) => {
              const next = new Set(current);
              if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
              return next;
            })}
            className="flex min-h-8 min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-xs text-neutral-300 hover:bg-neutral-800">
            {open.has(entry.path) ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
            <Folder size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{entry.name}</span>
          </button>
          <WorkPathReferenceButton workId={workId} name={entry.name} absolutePath={entry.absolutePath} />
          </div>
          {open.has(entry.path) && <div className="ml-3 border-l border-neutral-800 pl-1">
            <Directory key={entry.path} workId={workId} directory={entry.path} version={version} active={active} />
          </div>}
        </> : entry.kind === "file" ? <div className="flex min-w-0 items-center gap-1"><a
          href={`/api/works/${encodeURIComponent(workId)}/files?${new URLSearchParams({ path: entry.path, open: "1" })}`}
          target="_blank" rel="noopener noreferrer" title={`Open ${entry.name} in a new tab`}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded px-1 pl-4 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-emerald-300">
          <File size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{entry.name}</span>
        </a><WorkPathReferenceButton workId={workId} name={entry.name} absolutePath={entry.absolutePath} /></div> : <span className="block truncate px-1 py-1 pl-4 text-xs text-neutral-500" title="Special files and symbolic links are not exposed">
          {entry.name}
        </span>}
      </li>)}
      {loading && <li className="flex items-center gap-2 p-2 text-xs text-neutral-400"><LoaderCircle size={13} className="animate-spin" aria-hidden="true" />Loading files...</li>}
      {!loading && !error && entries.length === 0 && <li className="p-2 text-xs text-neutral-400">{emptyMessage}</li>}
      {error && <li role="alert" className="p-2 text-xs text-red-400">{error}
        <button type="button" className="ml-2 underline" onClick={() => requestPage(currentRequest?.offset ?? 0)}>Retry</button>
      </li>}
      {nextOffset !== null && !loading && !error && <li>
        <button type="button" className="p-2 text-xs text-emerald-400" onClick={() => requestPage(nextOffset)}>Load more files</button>
      </li>}
    </ul>
  );
}

const scopeLabel = (scope: WorkFileLocation) => scope === "shared" ? "Shared" : pairedLaneInfo[scope].label;
const scopeListLabel = (scope: WorkFileLocation) => scope === "shared" ? "Shared Work files" : `${scopeLabel(scope)} output files`;

function PairedFileScopes({ workId, pairedOutputRoot, version }: { workId: string; pairedOutputRoot: string; version: number }) {
  const prefix = useId();
  const standalone = useWorkFileLocations();
  const workspace = useContext(WorkFileNavigationContext);
  const { location: scope, visited, selectLocation } = workspace ?? standalone;

  return <>
    <div role="tablist" aria-label="Work file locations" className="work-file-scopes" onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const current = workFileLocations.indexOf(scope);
      const next = event.key === "Home" ? workFileLocations[0] : event.key === "End" ? workFileLocations.at(-1)
        : event.key === "ArrowLeft" ? workFileLocations[(current + workFileLocations.length - 1) % workFileLocations.length]
          : event.key === "ArrowRight" ? workFileLocations[(current + 1) % workFileLocations.length] : undefined;
      if (!next) return;
      event.preventDefault();
      selectLocation(next);
      document.getElementById(`${prefix}-tab-${next}`)?.focus();
    }}>
      {workFileLocations.map((location) => <button key={location} type="button" role="tab" className="work-file-scope"
        id={`${prefix}-tab-${location}`} aria-controls={`${prefix}-folder-${location}`}
        aria-selected={scope === location} tabIndex={scope === location ? 0 : -1} onClick={() => selectLocation(location)}>
        {scopeLabel(location)}
      </button>)}
    </div>
    {workFileLocations.map((location) => {
      const directory = location === "shared" ? "" : `${pairedOutputRoot}/${pairedLaneInfo[location].folder}`;
      const selected = scope === location;
      return <section key={location} id={`${prefix}-folder-${location}`} role="tabpanel"
        aria-labelledby={`${prefix}-tab-${location}`} hidden={!selected} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1 px-1 text-[10px] text-neutral-400" title={directory || undefined}>
          {location === "shared" ? "Shared Work folder" : `${scopeLabel(location)} results and Run artifacts`}
        </p>
        {visited.has(location) && <Directory workId={workId} directory={directory} version={version} active={selected}
          label={scopeListLabel(location)} emptyMessage={location === "shared" ? undefined : "No files in this output folder yet. Refresh after the Run writes files."} />}
      </section>;
    })}
  </>;
}

export default function WorkFileBrowser({ workId, pairedOutputRoot }: { workId: string; pairedOutputRoot?: string }) {
  const [version, setVersion] = useState(0);
  const navigation = useContext(WorkFileNavigationContext);
  const returnToConversation = pairedOutputRoot ? navigation?.returnToConversation : undefined;
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
        <div className="flex min-w-0 items-center gap-1">
          {returnToConversation && <button type="button" onClick={returnToConversation}
            className="work-toolbar-action size-8 shrink-0" title="Back to Conversation" aria-label="Back to Conversation">
            <ArrowLeft size={15} aria-hidden="true" />
          </button>}
          <h2 className="text-xs font-semibold text-neutral-300">Work files</h2>
        </div>
        <button type="button" title="Refresh files" aria-label="Refresh files" onClick={() => setVersion((current) => current + 1)}
          className="grid size-8 place-items-center rounded text-neutral-400 hover:bg-neutral-800">
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      <p className="text-[10px] text-neutral-400">Read-only · open files or insert their paths into Follow Up</p>
      {pairedOutputRoot ? <PairedFileScopes key={workId} workId={workId} pairedOutputRoot={pairedOutputRoot} version={version} />
        : <div className="min-h-0 flex-1 overflow-y-auto">
          <Directory key={workId} workId={workId} directory="" version={version} />
        </div>}
    </div>
  );
}
