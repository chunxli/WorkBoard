"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArrowUpRight,
  Bot,
  Boxes,
  ChevronDown,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  GripVertical,
  LoaderCircle,
  MessageSquareText,
  Gauge,
  Play,
  Plus,
  SquareKanban,
  TerminalSquare,
} from "lucide-react";
import FolderBrowserModal from "@/components/FolderBrowserModal";
import ConfirmFolderCopyModal from "@/components/ConfirmFolderCopyModal";
import PromptTemplatePicker from "@/components/PromptTemplatePicker";
import RootDirectoryPicker, {
  type RootDirectoryOption,
} from "@/components/RootDirectoryPicker";
import StatusBadge from "@/components/StatusBadge";
import WorkExecutionFields, {
  workExecutionSettingsPayload,
} from "@/components/WorkExecutionFields";
import {
  type ExecutionDefaultsValue,
  workExecutionSettingsValue,
} from "@/lib/execution-defaults";
import { formatTokenCount } from "@/lib/format";

type Initialization = "USE_PATH" | "COPY_REPO";

interface WorkSummary {
  id: string;
  name: string;
  directoryPath: string;
  promptFileName: string;
  status: "ACTIVE" | "REVIEW" | "ARCHIVED";
  defaultEngine: "CLI" | "SDK";
  updatedAt: string;
  updatedAtLabel: string;
  automationCount: number;
  latestRunStatus: string | null;
  latestRunId: string | null;
  latestModels: string[];
  latestTokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  } | null;
  terminalResumeState: "ready" | "active" | "unavailable";
}

interface ResourceOption {
  id: string;
  name: string;
  location: string;
}

interface DirectoryPromptFile {
  name: string;
  size: number;
  modifiedAt: string;
}

function inferName(directoryPath: string): string {
  const trimmed = directoryPath.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? "";
}

export default function WorkBoard({
  works,
  resources,
  shortcuts,
  executionDefaults,
  canOpenExplorer,
}: {
  works: WorkSummary[];
  resources: ResourceOption[];
  shortcuts: RootDirectoryOption[];
  executionDefaults: ExecutionDefaultsValue;
  canOpenExplorer: boolean;
}) {
  const router = useRouter();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [orderedWorks, setOrderedWorks] = useState(works);
  const [directoryPath, setDirectoryPath] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [folderPromptFiles, setFolderPromptFiles] = useState<DirectoryPromptFile[]>([]);
  const [selectedFolderPrompt, setSelectedFolderPrompt] = useState("");
  const [loadedFolderPrompt, setLoadedFolderPrompt] = useState<string | null>(null);
  const [folderPromptError, setFolderPromptError] = useState<string | null>(null);
  const [loadingFolderPrompt, setLoadingFolderPrompt] = useState(false);
  const promptImportRequest = useRef(0);
  const [initialization, setInitialization] = useState<Initialization>("USE_PATH");
  const [sourceRepoId, setSourceRepoId] = useState(resources[0]?.id ?? "");
  const [executionSettings, setExecutionSettings] = useState(
    workExecutionSettingsValue(executionDefaults)
  );
  const [browsingDirectory, setBrowsingDirectory] = useState(false);
  const [copyConfirmationPath, setCopyConfirmationPath] = useState<string | null>(null);
  const [copyingFolder, setCopyingFolder] = useState(false);
  const [copiedFolderPath, setCopiedFolderPath] = useState<string | null>(null);
  const [openingCopiedFolder, setOpeningCopiedFolder] = useState(false);
  const [submitting, setSubmitting] = useState<"create" | "run" | "terminal" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [openingWorkPath, setOpeningWorkPath] = useState<string | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [archivingWorkId, setArchivingWorkId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [view, setView] = useState<"current" | "archived">("current");

  function updateDirectoryPath(value: string) {
    promptImportRequest.current += 1;
    setDirectoryPath(value);
    setCopiedFolderPath(null);
    setFolderPromptFiles([]);
    setSelectedFolderPrompt("");
    setLoadedFolderPrompt(null);
    setFolderPromptError(null);
    setLoadingFolderPrompt(false);
    if (!nameTouched) setName(inferName(value));
  }

  function selectDirectoryPath(value: string) {
    const shouldClearImportedPrompt = loadedFolderPrompt !== null;
    updateDirectoryPath(value);
    if (shouldClearImportedPrompt) setPrompt("");
    void discoverFolderPrompts(value.trim(), false);
  }

  function updatePrompt(value: string) {
    setPrompt(value);
    setLoadedFolderPrompt(null);
  }

  async function readFolderPrompt(
    selectedDirectory: string,
    promptFileName: string,
    requestId: number
  ) {
    const response = await fetch(
      `/api/fs/prompts?path=${encodeURIComponent(selectedDirectory)}&file=${encodeURIComponent(promptFileName)}`
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.content !== "string") {
      throw new Error(
        typeof body.error === "string" ? body.error : "Failed to read Prompt file"
      );
    }
    if (promptImportRequest.current !== requestId) return;
    setPrompt(body.content);
    setSelectedFolderPrompt(promptFileName);
    setLoadedFolderPrompt(promptFileName);
  }

  async function discoverFolderPrompts(
    selectedDirectory = directoryPath.trim(),
    reportMissing = true
  ) {
    if (!selectedDirectory) {
      setFolderPromptError("Select a Work directory first");
      return;
    }

    const requestId = ++promptImportRequest.current;
    setLoadingFolderPrompt(true);
    setFolderPromptError(null);
    setLoadedFolderPrompt(null);
    try {
      const response = await fetch(
        `/api/fs/prompts?path=${encodeURIComponent(selectedDirectory)}`
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.files)) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to find Prompt files"
        );
      }
      if (promptImportRequest.current !== requestId) return;
      const files = body.files.filter(
        (candidate: unknown): candidate is DirectoryPromptFile =>
          typeof candidate === "object" &&
          candidate !== null &&
          "name" in candidate &&
          typeof candidate.name === "string"
      );
      if (files.length === 0) {
        setFolderPromptFiles([]);
        setSelectedFolderPrompt("");
        if (reportMissing) {
          throw new Error("No Prompt, PROMPT.md, or numbered Prompt file found in this directory");
        }
        return;
      }
      setFolderPromptFiles(files);
      setSelectedFolderPrompt(files[0].name);
      await readFolderPrompt(selectedDirectory, files[0].name, requestId);
    } catch (reason) {
      if (promptImportRequest.current === requestId) {
        setFolderPromptError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (promptImportRequest.current === requestId) setLoadingFolderPrompt(false);
    }
  }

  async function loadSelectedFolderPrompt(promptFileName = selectedFolderPrompt) {
    const selectedDirectory = directoryPath.trim();
    if (!selectedDirectory || !promptFileName) return;
    const requestId = ++promptImportRequest.current;
    setLoadingFolderPrompt(true);
    setFolderPromptError(null);
    setLoadedFolderPrompt(null);
    try {
      await readFolderPrompt(selectedDirectory, promptFileName, requestId);
    } catch (reason) {
      if (promptImportRequest.current === requestId) {
        setFolderPromptError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (promptImportRequest.current === requestId) setLoadingFolderPrompt(false);
    }
  }

  function requestFolderCopy() {
    const selectedFolder = directoryPath.trim();
    if (!selectedFolder) {
      setError("Select a folder to copy first");
      return;
    }
    setError(null);
    setCopyConfirmationPath(selectedFolder);
  }

  async function copySelectedFolder(selectedFolder: string) {
    setCopyingFolder(true);
    setCopiedFolderPath(null);
    setError(null);
    try {
      const response = await fetch("/api/fs/copy-numbered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFolder }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.destinationPath !== "string") {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to copy folder"
        );
      }
      selectDirectoryPath(body.destinationPath);
      setCopiedFolderPath(body.destinationPath);
      setInitialization("USE_PATH");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCopyingFolder(false);
    }
  }

  async function openCopiedFolderInExplorer() {
    if (!copiedFolderPath) return;
    setOpeningCopiedFolder(true);
    setError(null);
    try {
      const response = await fetch("/api/fs/open-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: copiedFolderPath }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to open copied folder"
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpeningCopiedFolder(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const action = submitter?.value === "create" || submitter?.value === "terminal"
      ? submitter.value
      : "run";
    setSubmitting(action);
    setError(null);
    try {
      const response = await fetch("/api/works", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || inferName(directoryPath) || "Untitled work",
          directoryPath,
          prompt,
          initialization,
          sourceRepoId: initialization === "COPY_REPO" ? sourceRepoId : null,
          ...workExecutionSettingsPayload(executionSettings),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to create Work");
      }
      if (action === "run") {
        const runResponse = await fetch(`/api/works/${body.id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            engine: executionSettings.defaultEngine,
            conflictMode: "DIRECT",
          }),
        });
        if (!runResponse.ok) {
          const runBody = await runResponse.json().catch(() => ({}));
          const startError =
            typeof runBody.error === "string"
              ? runBody.error
              : "Work was created but failed to start";
          router.push(`/work/${body.id}?startError=${encodeURIComponent(startError)}`);
          return;
        }
      } else if (action === "terminal") {
        const terminalResponse = await fetch(`/api/works/${body.id}/start-terminal`, {
          method: "POST",
        });
        const terminalBody = await terminalResponse.json().catch(() => ({}));
        if (!terminalResponse.ok || typeof terminalBody.runId !== "string") {
          const startError = typeof terminalBody.error === "string"
            ? terminalBody.error
            : "Work was created but Terminal failed to open";
          router.push(`/work/${body.id}?startError=${encodeURIComponent(startError)}`);
          return;
        }
        router.push(`/runs/${terminalBody.runId}`);
        return;
      }
      router.push(`/work/${body.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(null);
    }
  }

  async function openWorkInExplorer(directoryPath: string) {
    setOpeningWorkPath(directoryPath);
    setExplorerError(null);
    try {
      const response = await fetch("/api/fs/open-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: directoryPath }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to open Windows Explorer"
        );
      }
    } catch (reason) {
      setExplorerError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpeningWorkPath(null);
    }
  }

  async function resumeWorkInTerminal(work: WorkSummary) {
    if (!work.latestRunId || work.terminalResumeState !== "ready") return;
    setResumingRunId(work.latestRunId);
    setTerminalError(null);
    try {
      const response = await fetch(`/api/runs/${work.latestRunId}/resume-terminal`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.runId !== "string") {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to resume in Windows Terminal"
        );
      }
      router.push(`/runs/${body.runId}`);
    } catch (reason) {
      setTerminalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setResumingRunId(null);
    }
  }

  async function archiveWork(work: WorkSummary) {
    if (work.status === "ARCHIVED" || archivingWorkId !== null) return;
    if (!confirm(`Archive ${work.name}? Its directory and Run history will be kept.`)) return;

    setArchivingWorkId(work.id);
    setArchiveError(null);
    try {
      const response = await fetch(`/api/works/${work.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ARCHIVED" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to archive Work"
        );
      }
      const updatedAt = typeof body.updatedAt === "string"
        ? body.updatedAt
        : new Date().toISOString();
      setOrderedWorks((current) => current.map((candidate) =>
        candidate.id === work.id
          ? {
              ...candidate,
              status: "ARCHIVED",
              updatedAt,
              updatedAtLabel: new Date(updatedAt).toLocaleString("zh-CN", { hour12: false }),
            }
          : candidate
      ));
      router.refresh();
    } catch (reason) {
      setArchiveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArchivingWorkId(null);
    }
  }

  async function reorderCurrentWorks(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id || savingOrder) return;
    const currentWorks = orderedWorks.filter((work) => work.status !== "ARCHIVED");
    const oldIndex = currentWorks.findIndex((work) => work.id === event.active.id);
    const newIndex = currentWorks.findIndex((work) => work.id === event.over?.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(currentWorks, oldIndex, newIndex);
    const previousWorks = orderedWorks;
    setOrderedWorks([
      ...reordered,
      ...orderedWorks.filter((work) => work.status === "ARCHIVED"),
    ]);
    setSavingOrder(true);
    setOrderError(null);
    try {
      const response = await fetch("/api/works/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workIds: reordered.map((work) => work.id) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to save Work order"
        );
      }
    } catch (reason) {
      setOrderedWorks(previousWorks);
      setOrderError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingOrder(false);
    }
  }

  const currentWorks = orderedWorks.filter((work) => work.status !== "ARCHIVED");
  const archivedWorks = orderedWorks
    .filter((work) => work.status === "ARCHIVED")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visibleWorks = view === "archived" ? archivedWorks : currentWorks;
  const currentCount = currentWorks.length;
  const archivedCount = archivedWorks.length;

  return (
    <div className="space-y-8">
      <header className="page-header flex flex-col gap-4 border-b border-neutral-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-[11px] font-bold uppercase text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(67,209,158,0.7)]" />
            Local workspace
          </p>
          <h1 className="mt-2 text-2xl font-bold text-white sm:text-[28px]">Work Board</h1>
        </div>
        <div className="flex items-center gap-4 text-xs text-neutral-500">
          <span><strong className="font-mono font-medium text-neutral-200">{currentCount}</strong> current</span>
          <span className="h-3 w-px bg-neutral-700" />
          <span><strong className="font-mono font-medium text-neutral-200">{archivedCount}</strong> archived</span>
        </div>
      </header>

      <form
        onSubmit={onSubmit}
        className="ui-panel ui-panel-elevated work-composer-panel overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3.5 sm:px-5">
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-md bg-emerald-950 text-emerald-300">
              <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
            </span>
            <h2 className="text-sm font-bold text-neutral-100">New work</h2>
          </div>
          <span className="rounded-full border border-neutral-700 bg-neutral-950 px-2.5 py-1 font-mono text-[10px] uppercase text-neutral-500">
            Local
          </span>
        </div>

        <div className="grid gap-6 p-4 sm:p-5 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.35fr)]">
          <fieldset disabled={copyingFolder} className="min-w-0 space-y-4 border-0 p-0">
            <label className="flex items-center gap-2 text-xs font-bold uppercase text-neutral-400" htmlFor="work-directory">
              <FolderOpen size={14} aria-hidden="true" />
              Directory
            </label>
            <div className="flex gap-2">
              <input
                id="work-directory"
                value={directoryPath}
                onChange={(event) => updateDirectoryPath(event.target.value)}
                placeholder="C:\\work\\my-task"
                required
                className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950/80 px-3 py-2.5 font-mono text-xs text-neutral-200 shadow-inner shadow-black/20 placeholder:font-sans placeholder:text-sm focus:border-emerald-700"
              />
              <button
                type="button"
                onClick={() => setBrowsingDirectory(true)}
                className="flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-200 hover:border-neutral-600 hover:bg-neutral-700"
              >
                <Folder size={15} aria-hidden="true" />
                Browse
              </button>
            </div>
            <RootDirectoryPicker
              initialRoots={shortcuts}
              selectedPath={directoryPath}
              canOpenExplorer={canOpenExplorer}
              onSelect={selectDirectoryPath}
            />
            <div className="grid grid-cols-3 rounded-md border border-neutral-800 bg-neutral-950 p-1 text-xs">
              <button
                type="button"
                onClick={() => setInitialization("USE_PATH")}
                className={`flex min-w-0 items-center justify-center gap-1.5 rounded px-2 py-2 ${
                  initialization === "USE_PATH" && !copyingFolder
                    ? "bg-neutral-800 text-emerald-300 shadow-sm shadow-black/30"
                    : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                <Folder size={13} className="hidden sm:block" aria-hidden="true" />
                Use path
              </button>
              <button
                type="button"
                onClick={requestFolderCopy}
                disabled={!directoryPath.trim() || submitting !== null}
                className={`flex min-w-0 items-center justify-center gap-1.5 rounded px-2 py-2 disabled:cursor-not-allowed disabled:opacity-40 ${
                  copyingFolder
                    ? "bg-neutral-800 text-emerald-300 shadow-sm shadow-black/30"
                    : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                {copyingFolder ? (
                  <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Copy size={13} className="hidden sm:block" aria-hidden="true" />
                )}
                {copyingFolder ? "Copying..." : "Copy folder"}
              </button>
              <button
                type="button"
                onClick={() => setInitialization("COPY_REPO")}
                className={`flex min-w-0 items-center justify-center gap-1.5 rounded px-2 py-2 ${
                  initialization === "COPY_REPO"
                    ? "bg-neutral-800 text-emerald-300 shadow-sm shadow-black/30"
                    : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                <Boxes size={13} className="hidden sm:block" aria-hidden="true" />
                Copy resource
              </button>
            </div>
            {copiedFolderPath && (
              <div className="flex items-center gap-3 rounded-md border border-emerald-800 bg-emerald-950/35 px-3 py-2.5">
                <Copy size={14} className="shrink-0 text-emerald-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-emerald-300">Copy ready</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500" title={copiedFolderPath}>
                    {copiedFolderPath}
                  </p>
                </div>
                {canOpenExplorer && (
                  <button
                    type="button"
                    onClick={() => void openCopiedFolderInExplorer()}
                    disabled={openingCopiedFolder}
                    className="ui-secondary-button min-h-8 shrink-0 px-2.5 py-1.5 text-xs"
                  >
                    {openingCopiedFolder ? (
                      <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <FolderOpen size={13} aria-hidden="true" />
                    )}
                    Open copy
                  </button>
                )}
              </div>
            )}
            {initialization === "COPY_REPO" && (
              <select
                value={sourceRepoId}
                onChange={(event) => setSourceRepoId(event.target.value)}
                required
                className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm"
              >
                <option value="" disabled>Select a resource</option>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name} - {resource.location}
                  </option>
                ))}
              </select>
            )}
          </fieldset>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs font-bold uppercase text-neutral-400" htmlFor="work-prompt">
                <MessageSquareText size={14} aria-hidden="true" />
                Prompt
              </label>
              <button
                type="button"
                onClick={() => void discoverFolderPrompts()}
                disabled={!directoryPath.trim() || loadingFolderPrompt || submitting !== null}
                className="ui-secondary-button min-h-8 px-2.5 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loadingFolderPrompt ? (
                  <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                ) : (
                  <FileText size={13} aria-hidden="true" />
                )}
                {loadingFolderPrompt ? "Reading..." : "Read Prompt"}
              </button>
            </div>
            <PromptTemplatePicker value={prompt} onChange={updatePrompt} />
            {folderPromptFiles.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/45 p-2.5">
                <FileText size={14} className="shrink-0 text-emerald-400" aria-hidden="true" />
                <select
                  aria-label="Prompt file"
                  value={selectedFolderPrompt}
                  onChange={(event) => {
                    const promptFileName = event.target.value;
                    setSelectedFolderPrompt(promptFileName);
                    void loadSelectedFolderPrompt(promptFileName);
                  }}
                  disabled={loadingFolderPrompt}
                  className="min-w-48 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-2 font-mono text-xs text-neutral-200"
                >
                  {folderPromptFiles.map((file) => (
                    <option key={file.name} value={file.name}>{file.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void loadSelectedFolderPrompt()}
                  disabled={loadingFolderPrompt}
                  className="ui-secondary-button min-h-8 px-3 py-1.5 text-xs"
                >
                  Load selected
                </button>
              </div>
            )}
            {loadedFolderPrompt && (
              <p role="status" className="text-xs text-emerald-400">
                Loaded {loadedFolderPrompt}. The original file will not be changed.
              </p>
            )}
            {folderPromptError && (
              <p role="alert" className="text-xs text-red-400">{folderPromptError}</p>
            )}
            <textarea
              id="work-prompt"
              value={prompt}
              onChange={(event) => updatePrompt(event.target.value)}
              placeholder="Describe the result you want..."
              required
              rows={7}
              className="min-h-52 w-full resize-y rounded-md border border-neutral-700 bg-neutral-950/80 px-4 py-3 font-mono text-sm leading-6 text-neutral-200 shadow-inner shadow-black/20 placeholder:font-sans placeholder:text-neutral-600 focus:border-emerald-700"
            />
          </div>
        </div>

        <details className="group border-t border-neutral-800">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-medium text-neutral-500 hover:bg-neutral-800/40 hover:text-neutral-200 sm:px-5">
            <ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" />
            Advanced settings
          </summary>
          <div className="space-y-4 border-t border-neutral-800 bg-neutral-950/30 px-4 py-4 sm:px-5">
            <label className="block max-w-md text-xs text-neutral-400">
              Name
              <input
                value={name}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                }}
                className="mt-1.5 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm text-white"
              />
            </label>
            <WorkExecutionFields value={executionSettings} onChange={setExecutionSettings} />
          </div>
        </details>

        {error && <p role="alert" className="border-t border-red-900/50 bg-red-950/20 px-5 py-3 text-sm text-red-300">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-800 bg-neutral-950/30 px-4 py-4 sm:px-5">
          <button
            type="submit"
            value="run"
            disabled={submitting !== null || copyingFolder}
            className="order-3 flex items-center gap-2 rounded-md bg-emerald-400 px-4 py-2.5 text-sm font-bold text-[var(--on-accent)] shadow-[0_8px_24px_rgba(67,209,158,0.14)] hover:-translate-y-px hover:bg-emerald-300 disabled:translate-y-0 disabled:opacity-50"
          >
            <Play size={15} fill="currentColor" aria-hidden="true" />
            {submitting === "run" ? "Creating & starting..." : "Create & Run"}
          </button>
          {canOpenExplorer && (
            <button
              type="submit"
              value="terminal"
              disabled={submitting !== null || copyingFolder}
              className="ui-secondary-button order-2 min-h-10 px-4 py-2.5 font-semibold disabled:opacity-50"
            >
              {submitting === "terminal" ? (
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <TerminalSquare size={15} aria-hidden="true" />
              )}
              {submitting === "terminal" ? "Creating & opening..." : "Create & Open Terminal"}
            </button>
          )}
          <button
            type="submit"
            value="create"
            disabled={submitting !== null || copyingFolder}
            className="order-1 flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 hover:text-white disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" />
            {submitting === "create" ? "Creating..." : "Create only"}
          </button>
        </div>
      </form>

      {browsingDirectory && (
        <FolderBrowserModal
          onClose={() => setBrowsingDirectory(false)}
          onSelect={(selectedPath) => {
            selectDirectoryPath(selectedPath);
            setBrowsingDirectory(false);
          }}
        />
      )}

      {copyConfirmationPath && (
        <ConfirmFolderCopyModal
          sourcePath={copyConfirmationPath}
          onCancel={() => setCopyConfirmationPath(null)}
          onConfirm={() => {
            const selectedFolder = copyConfirmationPath;
            setCopyConfirmationPath(null);
            void copySelectedFolder(selectedFolder);
          }}
        />
      )}

      <section className="space-y-3">
        <div className="flex flex-col gap-3 border-b border-neutral-800 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold text-neutral-100">
            {view === "archived" ? <Archive size={17} aria-hidden="true" /> : <SquareKanban size={17} aria-hidden="true" />}
            {view === "archived" ? "Archived" : "Current work"}
          </h2>
          <div className="flex items-center gap-3">
            {savingOrder && (
              <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
                Saving order
              </span>
            )}
            <div role="tablist" aria-label="Work view" className="flex w-fit rounded-md border border-neutral-800 bg-neutral-950 p-1 text-xs font-medium">
              <button
                type="button"
                role="tab"
                aria-selected={view === "current"}
                onClick={() => setView("current")}
                className={`rounded px-3 py-1.5 ${view === "current" ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}
              >
                Current <span className="ml-1 font-mono text-[10px] text-neutral-500">{currentCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "archived"}
                onClick={() => setView("archived")}
                className={`rounded px-3 py-1.5 ${view === "archived" ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-white"}`}
              >
                Archived <span className="ml-1 font-mono text-[10px] text-neutral-500">{archivedCount}</span>
              </button>
            </div>
          </div>
        </div>
        <div className="space-y-3">
          {explorerError && (
            <p role="alert" className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-400">
              {explorerError}
            </p>
          )}
          {terminalError && (
            <p role="alert" className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-400">
              {terminalError}
            </p>
          )}
          {archiveError && (
            <p role="alert" className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-400">
              {archiveError}
            </p>
          )}
          {orderError && (
            <p role="alert" className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-400">
              {orderError}
            </p>
          )}
          <DndContext
            id="current-work-order"
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => {
              if (view === "current") void reorderCurrentWorks(event);
            }}
          >
            <SortableContext
              items={visibleWorks.map((work) => work.id)}
              strategy={rectSortingStrategy}
            >
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {visibleWorks.map((work) => (
                  <SortableWorkCard
                    key={work.id}
                    work={work}
                    draggable={view === "current" && currentCount > 1 && !savingOrder}
                    canOpenExplorer={canOpenExplorer && view === "current"}
                    openingWorkPath={openingWorkPath}
                    onOpenExplorer={(path) => void openWorkInExplorer(path)}
                    resumingRunId={resumingRunId}
                    onResumeInTerminal={(selectedWork) => void resumeWorkInTerminal(selectedWork)}
                    canArchive={view === "current"}
                    archivingWorkId={archivingWorkId}
                    onArchive={(selectedWork) => void archiveWork(selectedWork)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {visibleWorks.length === 0 && (
            <div className="grid min-h-36 place-items-center rounded-lg border border-dashed border-neutral-800 bg-neutral-950/20 text-center">
              <div>
                {view === "archived" ? (
                  <Archive size={20} className="mx-auto mb-2 text-neutral-700" aria-hidden="true" />
                ) : (
                  <SquareKanban size={20} className="mx-auto mb-2 text-neutral-700" aria-hidden="true" />
                )}
                <p className="text-sm text-neutral-500">
                  {view === "archived" ? "No archived work" : "No current work"}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SortableWorkCard({
  work,
  draggable,
  canOpenExplorer,
  openingWorkPath,
  onOpenExplorer,
  resumingRunId,
  onResumeInTerminal,
  canArchive,
  archivingWorkId,
  onArchive,
}: {
  work: WorkSummary;
  draggable: boolean;
  canOpenExplorer: boolean;
  openingWorkPath: string | null;
  onOpenExplorer: (directoryPath: string) => void;
  resumingRunId: string | null;
  onResumeInTerminal: (work: WorkSummary) => void;
  canArchive: boolean;
  archivingWorkId: string | null;
  onArchive: (work: WorkSummary) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: work.id, disabled: !draggable });
  const modelLabel = work.latestModels.length > 1
    ? `${work.latestModels[0]} +${work.latestModels.length - 1}`
    : work.latestModels[0] ?? "Auto";
  const tokenUsage = work.latestTokenUsage;
  const totalTokens = tokenUsage
    ? tokenUsage.inputTokens + tokenUsage.outputTokens
    : null;
  const tokenTooltip = tokenUsage
    ? [
        `Input: ${tokenUsage.inputTokens.toLocaleString()}`,
        `Output: ${tokenUsage.outputTokens.toLocaleString()}`,
        `Cache read: ${tokenUsage.cacheReadTokens.toLocaleString()}`,
        `Cache write: ${tokenUsage.cacheWriteTokens.toLocaleString()}`,
        `Reasoning: ${tokenUsage.reasoningTokens.toLocaleString()}`,
      ].join(" · ")
    : "Token usage is available after the Run session shuts down";

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative flex min-h-56 flex-col rounded-lg border bg-neutral-900/60 p-4 shadow-sm transition-[border-color,background-color,box-shadow,opacity] ${
        isDragging
          ? "z-10 border-emerald-600 bg-neutral-900 opacity-80 shadow-2xl shadow-black/30"
          : "border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/85 hover:shadow-lg hover:shadow-black/10"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/work/${work.id}`}
            className="line-clamp-2 rounded text-base font-bold leading-6 text-white hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          >
            {work.name}
          </Link>
          <span className="mt-2 inline-flex rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[9px] uppercase text-neutral-500">
            {work.status}
          </span>
        </div>
        {draggable && (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${work.name}`}
            title="Drag to reorder"
            className="grid size-8 shrink-0 touch-none cursor-grab place-items-center rounded-md text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200 active:cursor-grabbing"
          >
            <GripVertical size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="mt-4 flex min-w-0 items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950/35 px-3 py-2.5">
        <Folder size={14} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
        <span className="line-clamp-2 break-all font-mono text-[11px] leading-4 text-neutral-500" title={work.directoryPath}>
          {work.directoryPath}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
        <span className="rounded-md border border-neutral-800 bg-neutral-950/35 px-2 py-1 font-mono">
          {work.defaultEngine}
        </span>
        <span
          className="inline-flex min-w-0 max-w-44 items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/35 px-2 py-1 font-mono"
          title={work.latestModels.length > 0 ? work.latestModels.join(", ") : "Automatic model selection"}
        >
          <Bot size={11} className="shrink-0 text-emerald-500" aria-hidden="true" />
          <span className="truncate">{modelLabel}</span>
        </span>
        {totalTokens !== null && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/35 px-2 py-1 font-mono"
            title={tokenTooltip}
          >
            <Gauge size={11} className="text-emerald-500" aria-hidden="true" />
            {formatTokenCount(totalTokens)} tokens
          </span>
        )}
        <span>{work.automationCount} automations</span>
        {work.latestRunStatus && <StatusBadge status={work.latestRunStatus} />}
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-neutral-800 pt-4">
        <span className="text-[10px] text-neutral-600">{work.updatedAtLabel}</span>
        <div className="flex shrink-0 items-center gap-1">
          {canOpenExplorer && (
            <button
              type="button"
              onClick={() => onOpenExplorer(work.directoryPath)}
              disabled={openingWorkPath !== null}
              aria-label={`Open ${work.name} in Windows Explorer`}
              title="Open in Windows Explorer"
              className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300 disabled:opacity-40"
            >
              {openingWorkPath === work.directoryPath ? (
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <FolderOpen size={15} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => onResumeInTerminal(work)}
            disabled={work.terminalResumeState !== "ready" || resumingRunId !== null}
            aria-label={
              work.terminalResumeState === "ready"
                ? `Resume ${work.name} in Windows Terminal`
                : work.terminalResumeState === "active"
                  ? `${work.name} is already open in Windows Terminal`
                  : `${work.name} has no resumable Terminal session`
            }
            title={
              work.terminalResumeState === "ready"
                ? "Resume in Windows Terminal"
                : work.terminalResumeState === "active"
                  ? "Already open in Windows Terminal"
                  : "No resumable Terminal session"
            }
            className={`grid size-8 place-items-center rounded-md disabled:cursor-not-allowed ${
              work.terminalResumeState === "active"
                ? "bg-emerald-950/35 text-emerald-400"
                : work.terminalResumeState === "ready"
                  ? "text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300 disabled:opacity-40"
                  : "text-neutral-700 opacity-55"
            }`}
          >
            {resumingRunId === work.latestRunId ? (
              <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <TerminalSquare size={15} aria-hidden="true" />
            )}
          </button>
          {canArchive && (
            <button
              type="button"
              onClick={() => onArchive(work)}
              disabled={archivingWorkId !== null}
              aria-label={`Archive ${work.name}`}
              title="Archive Work"
              className="grid size-8 place-items-center rounded-md text-neutral-600 hover:bg-neutral-800 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {archivingWorkId === work.id ? (
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <Archive size={15} aria-hidden="true" />
              )}
            </button>
          )}
          <Link
            href={`/work/${work.id}`}
            aria-label={`Open ${work.name}`}
            title="Open Work"
            className="grid size-8 place-items-center rounded-md text-neutral-600 hover:bg-neutral-800 hover:text-emerald-400"
          >
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </article>
  );
}