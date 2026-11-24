"use client";

import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, File, Folder, LoaderCircle, MessageSquarePlus, RefreshCw } from "lucide-react";
import { z } from "zod";
import { FollowUpComposerContext } from "@/components/FollowUpComposerContext";
import { pairedLaneInfo } from "@/lib/work-session-pair";
import { WorkFileNavigationContext, useWorkFileLocations, workFileLocations, type WorkFileLocation } from "@/components/WorkFileNavigationContext";

export interface FileEntry {
  name: string;
  path: string;
  absolutePath: string | null;
  kind: "directory" | "file" | "unsupported";
}

export type NewFileHighlightState = "active" | "fading";
export const NEW_FILE_FADE_MS = 420;

export const directoryPageSchema = z.object({
  entries: z.array(z.object({
    name: z.string(), path: z.string(), absolutePath: z.string().min(1).nullable(), kind: z.enum(["directory", "file", "unsupported"]),
  }).refine((entry) => entry.kind === "unsupported" || entry.absolutePath !== null, "An ordinary file or folder requires an absolute path.")),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const createdRunFilesSchema = z.object({
  createdPaths: z.array(z.string()),
});

export function isHighlightableWorkFilePath(relativePath: string): boolean {
  return Boolean(relativePath) && !relativePath.split("/").some(
    (segment) => !segment || segment.toLowerCase() === ".workboard" || segment.toLowerCase() === ".git",
  );
}

export function discoverNewDirectoryFiles(
  previousPaths: ReadonlySet<string> | null,
  previousComplete: boolean,
  currentEntries: readonly Pick<FileEntry, "path" | "kind">[],
): string[] {
  if (!previousPaths || !previousComplete) return [];
  return currentEntries
    .filter((entry) => entry.kind === "file" && isHighlightableWorkFilePath(entry.path) && !previousPaths.has(entry.path))
    .map((entry) => entry.path);
}

export function hasHighlightedDescendant(
  highlights: ReadonlyMap<string, NewFileHighlightState>,
  directoryPath: string,
): boolean {
  const prefix = directoryPath ? `${directoryPath}/` : "";
  for (const [filePath, state] of highlights) {
    if (state === "active" && filePath.startsWith(prefix)) return true;
  }
  return false;
}

export function scopeHasHighlightedFiles(
  highlights: ReadonlyMap<string, NewFileHighlightState>,
  pairedOutputRoot: string,
  location: WorkFileLocation,
): boolean {
  if (location === "shared") {
    const pairedPrefix = `${pairedOutputRoot}/`;
    for (const [filePath, state] of highlights) {
      if (state === "active" && !filePath.startsWith(pairedPrefix)) return true;
    }
    return false;
  }
  return hasHighlightedDescendant(highlights, `${pairedOutputRoot}/${pairedLaneInfo[location].folder}`);
}

export function activateNewFileHighlights(
  current: ReadonlyMap<string, NewFileHighlightState>,
  paths: Iterable<string>,
): ReadonlyMap<string, NewFileHighlightState> {
  let changed = false;
  const next = new Map(current);
  for (const filePath of paths) {
    if (!isHighlightableWorkFilePath(filePath)) continue;
    if (next.get(filePath) !== "active") {
      next.set(filePath, "active");
      changed = true;
    }
  }
  return changed ? next : current;
}

export function startNewFileFade(
  current: ReadonlyMap<string, NewFileHighlightState>,
  filePath: string,
): ReadonlyMap<string, NewFileHighlightState> {
  if (current.get(filePath) !== "active") return current;
  const next = new Map(current);
  next.set(filePath, "fading");
  return next;
}

export function finishNewFileFade(
  current: ReadonlyMap<string, NewFileHighlightState>,
  filePath: string,
): ReadonlyMap<string, NewFileHighlightState> {
  if (!current.has(filePath)) return current;
  const next = new Map(current);
  next.delete(filePath);
  return next;
}

export function WorkPathReferenceButton({
  workId,
  name,
  absolutePath,
  onUse,
}: {
  workId: string;
  name: string;
  absolutePath: string | null;
  onUse?: () => void;
}) {
  const composer = useContext(FollowUpComposerContext);
  const available = composer?.workId === workId && !composer.disabled && absolutePath !== null;
  return <button type="button" aria-label={`Insert ${name} path into Follow Up`}
    title={available ? `Insert ${absolutePath} into Follow Up` : "The Follow Up draft is not available for editing."}
    disabled={!available} onClick={() => {
      onUse?.();
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

export function Directory({
  workId,
  directory,
  version,
  detectNewAtVersion = -1,
  highlights,
  onNewFiles,
  onFileInteract,
  initialEntries,
  active = true,
  label,
  emptyMessage = "Empty folder.",
}: {
  workId: string;
  directory: string;
  version: number;
  detectNewAtVersion?: number;
  highlights?: ReadonlyMap<string, NewFileHighlightState>;
  onNewFiles?: (paths: string[]) => void;
  onFileInteract?: (path: string) => void;
  initialEntries?: FileEntry[];
  active?: boolean;
  label?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [request, setRequest] = useState<PageRequest | null>(null);
  const [loaded, setLoaded] = useState<LoadedDirectory | null>(() =>
    initialEntries ? { version, request: null, entries: initialEntries, nextOffset: null, error: null } : null,
  );
  const baselinePathsRef = useRef<Set<string> | null>(
    initialEntries ? new Set(initialEntries.map((entry) => entry.path)) : null,
  );
  const baselineCompleteRef = useRef(Boolean(initialEntries));
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
      if (offset === 0) {
        if (detectNewAtVersion === version) {
          const discovered = discoverNewDirectoryFiles(baselinePathsRef.current, baselineCompleteRef.current, page.entries);
          if (discovered.length > 0) onNewFiles?.(discovered);
        }
        baselinePathsRef.current = new Set(page.entries.map((entry) => entry.path));
        baselineCompleteRef.current = page.nextOffset === null;
      } else if (baselinePathsRef.current) {
        page.entries.forEach((entry) => baselinePathsRef.current?.add(entry.path));
        baselineCompleteRef.current = page.nextOffset === null;
      }
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
  }, [active, currentRequest, detectNewAtVersion, load, loading, onNewFiles, version]);

  function requestPage(offset: number) {
    setRequest({ version, offset });
  }

  return (
    <ul className="min-w-0 space-y-0.5" aria-label={label ?? (directory ? `${directory} files` : "Work directory files")} aria-busy={loading}>
      {entries.map((entry) => {
        const highlightState = entry.kind === "file" ? highlights?.get(entry.path) : undefined;
        const folderHasNew = entry.kind === "directory" && !open.has(entry.path) && highlights
          ? hasHighlightedDescendant(highlights, entry.path)
          : false;
        return <li key={entry.path} className="min-w-0">
          {entry.kind === "directory" ? <>
            <div className="flex min-w-0 items-center gap-1">
            <button type="button" aria-expanded={open.has(entry.path)} title={entry.name}
              data-has-new-files={folderHasNew ? "true" : undefined}
              onClick={() => setOpen((current) => {
                const next = new Set(current);
                if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
                return next;
              })}
              className="work-file-folder-button flex min-h-8 min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-xs text-neutral-300 hover:bg-neutral-800">
              {open.has(entry.path) ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
              <Folder size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{entry.name}</span>
              {folderHasNew && <span className="work-file-new-badge" aria-label="Contains new files">New</span>}
            </button>
            <WorkPathReferenceButton workId={workId} name={entry.name} absolutePath={entry.absolutePath} />
            </div>
            {open.has(entry.path) && <div className="ml-3 border-l border-neutral-800 pl-1">
              <Directory
                key={entry.path}
                workId={workId}
                directory={entry.path}
                version={version}
                detectNewAtVersion={detectNewAtVersion}
                highlights={highlights}
                onNewFiles={onNewFiles}
                onFileInteract={onFileInteract}
                active={active}
              />
            </div>}
          </> : entry.kind === "file" ? <div className="flex min-w-0 items-center gap-1"><a
            href={`/api/works/${encodeURIComponent(workId)}/files?${new URLSearchParams({ path: entry.path, open: "1" })}`}
            target="_blank" rel="noopener noreferrer" title={`Open ${entry.name} in a new tab`}
            data-new-file={highlightState}
            onClick={() => onFileInteract?.(entry.path)}
            onAuxClick={(event) => {
              if (event.button === 1) onFileInteract?.(entry.path);
            }}
            className="work-file-entry-link flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded px-1 pl-4 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-emerald-300">
            <File size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{entry.name}</span>
            {highlightState && <span className="work-file-new-badge" aria-hidden={highlightState === "fading" || undefined}>New</span>}
          </a><WorkPathReferenceButton workId={workId} name={entry.name} absolutePath={entry.absolutePath}
            onUse={() => onFileInteract?.(entry.path)} /></div> : <span className="block truncate px-1 py-1 pl-4 text-xs text-neutral-500" title="Special files and symbolic links are not exposed">
            {entry.name}
          </span>}
        </li>;
      })}
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

function PairedFileScopes({
  workId,
  pairedOutputRoot,
  version,
  detectNewAtVersion,
  highlights,
  onNewFiles,
  onFileInteract,
}: {
  workId: string;
  pairedOutputRoot: string;
  version: number;
  detectNewAtVersion: number;
  highlights: ReadonlyMap<string, NewFileHighlightState>;
  onNewFiles: (paths: string[]) => void;
  onFileInteract: (path: string) => void;
}) {
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
      {workFileLocations.map((location) => {
        const hasNew = scope !== location && scopeHasHighlightedFiles(highlights, pairedOutputRoot, location);
        return <button key={location} type="button" role="tab" className="work-file-scope"
          id={`${prefix}-tab-${location}`} aria-controls={`${prefix}-folder-${location}`}
          aria-selected={scope === location} tabIndex={scope === location ? 0 : -1} onClick={() => selectLocation(location)}>
          {scopeLabel(location)}
          {hasNew && <><span className="work-file-scope-dot" aria-hidden="true" /><span className="sr-only"> (new files)</span></>}
        </button>;
      })}
    </div>
    {workFileLocations.map((location) => {
      const directory = location === "shared" ? "" : `${pairedOutputRoot}/${pairedLaneInfo[location].folder}`;
      const selected = scope === location;
      return <section key={location} id={`${prefix}-folder-${location}`} role="tabpanel"
        aria-labelledby={`${prefix}-tab-${location}`} hidden={!selected} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1 px-1 text-[10px] text-neutral-400" title={directory || undefined}>
          {location === "shared" ? "Shared Work folder" : `${scopeLabel(location)} results and Run artifacts`}
        </p>
        {visited.has(location) && <Directory
          workId={workId}
          directory={directory}
          version={version}
          detectNewAtVersion={detectNewAtVersion}
          highlights={highlights}
          onNewFiles={onNewFiles}
          onFileInteract={onFileInteract}
          active={selected}
          label={scopeListLabel(location)}
          emptyMessage={location === "shared" ? undefined : "No files in this output folder yet. Refresh after the Run writes files."}
        />}
      </section>;
    })}
  </>;
}

const EMPTY_RUN_IDS: readonly string[] = [];

export default function WorkFileBrowser({
  workId,
  pairedOutputRoot,
  activeRunIds = EMPTY_RUN_IDS,
  initialHighlights,
}: {
  workId: string;
  pairedOutputRoot?: string;
  activeRunIds?: readonly string[];
  initialHighlights?: readonly string[];
}) {
  const [refreshState, setRefreshState] = useState({ version: 0, detectNewAtVersion: -1 });
  const [highlights, setHighlights] = useState<ReadonlyMap<string, NewFileHighlightState>>(() =>
    new Map((initialHighlights ?? []).filter(isHighlightableWorkFilePath).map((filePath) => [filePath, "active"])),
  );
  const fadeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const handledFinishedRunsRef = useRef<Set<string>>(new Set());
  const previousActiveRunsRef = useRef<Set<string>>(new Set(activeRunIds));
  const pendingControllersRef = useRef<Set<AbortController>>(new Set());
  const navigation = useContext(WorkFileNavigationContext);
  const returnToConversation = pairedOutputRoot ? navigation?.returnToConversation : undefined;

  const markNewFiles = useCallback((paths: Iterable<string>) => {
    const valid = [...paths].filter(isHighlightableWorkFilePath);
    if (valid.length === 0) return;
    for (const filePath of valid) {
      const existingTimer = fadeTimersRef.current.get(filePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
        fadeTimersRef.current.delete(filePath);
      }
    }
    setHighlights((current) => activateNewFileHighlights(current, valid));
  }, []);

  const dismissNewFile = useCallback((filePath: string) => {
    setHighlights((current) => {
      const next = startNewFileFade(current, filePath);
      if (next === current) return current;
      if (!fadeTimersRef.current.has(filePath)) {
        const timer = setTimeout(() => {
          fadeTimersRef.current.delete(filePath);
          setHighlights((latest) => finishNewFileFade(latest, filePath));
        }, NEW_FILE_FADE_MS);
        fadeTimersRef.current.set(filePath, timer);
      }
      return next;
    });
  }, []);

  const handleRunFinished = useCallback((runId: string) => {
    if (!runId || handledFinishedRunsRef.current.has(runId)) return;
    handledFinishedRunsRef.current.add(runId);
    setRefreshState((current) => {
      const nextVersion = current.version + 1;
      return { version: nextVersion, detectNewAtVersion: nextVersion };
    });

    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const query = new URLSearchParams({ createdInRun: runId });
    void fetch(`/api/works/${encodeURIComponent(workId)}/files?${query}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const parsed = createdRunFilesSchema.safeParse(await response.json());
      if (!controller.signal.aborted && parsed.success && parsed.data.createdPaths.length > 0) {
        markNewFiles(parsed.data.createdPaths);
      }
    }).catch(() => {}).finally(() => {
      pendingControllersRef.current.delete(controller);
    });
  }, [markNewFiles, workId]);

  useEffect(() => {
    const timers = fadeTimersRef.current;
    const controllers = pendingControllersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<{ workId: string }>).detail?.workId === workId) {
        setRefreshState((current) => ({ version: current.version + 1, detectNewAtVersion: current.detectNewAtVersion }));
      }
    };
    const onRunFinished = (event: Event) => {
      const detail = (event as CustomEvent<{ runId?: string; workId?: string }>).detail;
      if (!detail?.runId) return;
      if (detail.workId && detail.workId !== workId) return;
      handleRunFinished(detail.runId);
    };
    window.addEventListener("workboard:files-updated", refresh);
    window.addEventListener("workboard:run-finished", onRunFinished);
    return () => {
      window.removeEventListener("workboard:files-updated", refresh);
      window.removeEventListener("workboard:run-finished", onRunFinished);
    };
  }, [handleRunFinished, workId]);

  useEffect(() => {
    const nextActive = new Set(activeRunIds);
    const completed = [...previousActiveRunsRef.current].filter((id) => !nextActive.has(id));
    previousActiveRunsRef.current = nextActive;
    if (completed.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      completed.forEach((id) => handleRunFinished(id));
    });
    return () => {
      cancelled = true;
    };
  }, [activeRunIds, handleRunFinished]);

  const { version, detectNewAtVersion } = refreshState;

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
        <button type="button" title="Refresh files" aria-label="Refresh files"
          onClick={() => setRefreshState((current) => ({ version: current.version + 1, detectNewAtVersion: current.detectNewAtVersion }))}
          className="grid size-8 place-items-center rounded text-neutral-400 hover:bg-neutral-800">
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      <p className="text-[10px] text-neutral-400">Read-only · open files or insert their paths into Follow Up</p>
      {pairedOutputRoot ? <PairedFileScopes
        key={workId}
        workId={workId}
        pairedOutputRoot={pairedOutputRoot}
        version={version}
        detectNewAtVersion={detectNewAtVersion}
        highlights={highlights}
        onNewFiles={markNewFiles}
        onFileInteract={dismissNewFile}
      /> : <div className="min-h-0 flex-1 overflow-y-auto">
        <Directory
          key={workId}
          workId={workId}
          directory=""
          version={version}
          detectNewAtVersion={detectNewAtVersion}
          highlights={highlights}
          onNewFiles={markNewFiles}
          onFileInteract={dismissNewFile}
        />
      </div>}
    </div>
  );
}
