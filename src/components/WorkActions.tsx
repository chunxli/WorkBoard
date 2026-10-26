"use client";

import { useState } from "react";
import { Check, Clipboard } from "lucide-react";
import FollowUpDialog from "@/components/FollowUpDialog";
import WorkQuickActions from "@/components/WorkQuickActions";

export default function WorkActions({
  workId,
  name,
  directoryPath,
  archived,
  followUpMode,
  followUpDisabledReason,
  canOpenLocal,
  terminalRunId,
  terminalState,
}: {
  workId: string;
  name: string;
  directoryPath: string;
  archived: boolean;
  followUpMode: "resume" | "new";
  followUpDisabledReason?: string | null;
  canOpenLocal: boolean;
  terminalRunId: string | null;
  terminalState: "ready" | "active" | "unavailable";
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="work-detail-actions ml-auto flex min-w-0 flex-wrap items-center gap-1">
      <FollowUpDialog
        workId={workId}
        mode={followUpMode}
        disabledReason={followUpDisabledReason}
        inline
      />
      <button
        type="button"
        title={copied ? "Copied" : "Copy path"}
        aria-label={copied ? "Copied" : "Copy path"}
        onClick={async () => {
          await navigator.clipboard.writeText(directoryPath);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="work-toolbar-action work-toolbar-control size-8 shrink-0"
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />}
        <span className="sr-only" aria-live="polite">{copied ? "Copied" : "Copy path"}</span>
      </button>
      <WorkQuickActions
        name={name}
        directoryPath={directoryPath}
        canOpenLocal={canOpenLocal}
        terminalRunId={terminalRunId}
        terminalState={terminalState}
        archiveTarget={{ kind: "work", id: workId }}
        archived={archived}
        archiveRedirect="/work"
      />
    </div>
  );
}