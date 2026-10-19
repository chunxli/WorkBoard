"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Code2, FolderOpen, LoaderCircle, RotateCcw, TerminalSquare, type LucideIcon } from "lucide-react";

type QuickAction = "explorer" | "vscode" | "terminal" | "archive";

export default function WorkQuickActions({
  name,
  directoryPath,
  canOpenLocal,
  terminalRunId,
  terminalState,
  archiveTarget,
  archived,
  archiveRedirect,
}: {
  name: string;
  directoryPath: string;
  canOpenLocal: boolean;
  terminalRunId: string | null;
  terminalState: "ready" | "active" | "unavailable";
  archiveTarget: { kind: "work" | "task"; id: string } | null;
  archived: boolean;
  archiveRedirect?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<QuickAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function invoke(action: QuickAction) {
    if (busy !== null) return;
    if (action === "archive" && !archived && !confirm(`Archive ${name}? Its directory and Run history will be kept.`)) return;
    setBusy(action);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      let endpoint: string;
      let method = "POST";
      let payload: { path: string } | { status: string } | undefined;
      if (action === "explorer" || action === "vscode") {
        endpoint = `/api/fs/open-${action}`;
        payload = { path: directoryPath };
      } else if (action === "terminal") {
        if (!terminalRunId) throw new Error("No resumable Terminal session");
        endpoint = `/api/runs/${encodeURIComponent(terminalRunId)}/resume-terminal`;
      } else {
        if (!archiveTarget) throw new Error("No Work or Automation to archive");
        if (archiveTarget.kind === "work") {
          endpoint = `/api/works/${encodeURIComponent(archiveTarget.id)}`;
          method = "PATCH";
          payload = { status: archived ? "ACTIVE" : "ARCHIVED" };
        } else {
          endpoint = `/api/tasks/${encodeURIComponent(archiveTarget.id)}/archive`;
          method = archived ? "DELETE" : "POST";
        }
      }
      const response = await fetch(endpoint, {
        method,
        ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Action failed");
      if (action === "terminal") {
        if (typeof body.runId !== "string") throw new Error("Terminal Resume did not start");
        router.push(`/runs/${encodeURIComponent(body.runId)}`);
      } else if (action === "archive") {
        if (!archived && archiveRedirect) router.push(archiveRedirect);
        else router.refresh();
      }
    } catch (reason) {
      setError(reason instanceof DOMException && reason.name === "AbortError"
        ? "The request timed out. Refresh to check its status."
        : reason instanceof Error ? reason.message : String(reason));
    } finally {
      clearTimeout(timeout);
      setBusy(null);
      if (action === "terminal") router.refresh();
    }
  }

  const actions: { action: QuickAction; icon: LucideIcon; label: string; disabled: boolean }[] = [
    { action: "explorer", icon: FolderOpen, label: `Open ${name} in Windows Explorer`, disabled: !canOpenLocal || !directoryPath },
    { action: "vscode", icon: Code2, label: `Open ${name} in VS Code`, disabled: !canOpenLocal || !directoryPath },
    {
      action: "terminal", icon: TerminalSquare,
      label: terminalState === "active" ? `Check and resume ${name} in Windows Terminal`
        : terminalState === "ready" ? `Resume ${name} in Windows Terminal`
          : `${name} has no resumable Terminal session`,
      disabled: !canOpenLocal || !terminalRunId || terminalState === "unavailable" || archived,
    },
    { action: "archive", icon: archived ? RotateCcw : Archive, label: `${archived ? "Restore" : "Archive"} ${name}`, disabled: !archiveTarget },
  ];

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Quick actions">
      {actions.map(({ action, icon: Icon, label, disabled }) => (
        <button
          key={action}
          type="button"
          title={label}
          aria-label={label}
          disabled={disabled || busy !== null}
          onClick={() => void invoke(action)}
          className={`grid size-9 shrink-0 place-items-center rounded-md disabled:cursor-not-allowed disabled:opacity-40 ${
            action === "archive"
              ? "text-neutral-500 hover:bg-neutral-800 hover:text-amber-300"
              : "text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300"
          }`}
        >
          {busy === action ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
        </button>
      ))}
      {error && <span role="alert" className="basis-full pt-1 text-xs text-red-400">{error}</span>}
    </div>
  );
}