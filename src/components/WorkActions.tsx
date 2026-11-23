"use client";

import { useState } from "react";
import { Check, Clipboard, Ellipsis } from "lucide-react";
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
  paired = false,
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
  paired?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="work-detail-actions ml-auto flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Work actions">
      {!paired && <FollowUpDialog
        workId={workId}
        mode={followUpMode}
        disabledReason={followUpDisabledReason}
        inline
      />}
      <details className="work-toolbar-more" name="work-toolbar-panels">
        <summary aria-label="More Work actions" className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800 [&::-webkit-details-marker]:hidden">
          <Ellipsis size={15} aria-hidden="true" /> More
        </summary>
        <div className="work-toolbar-more-panel grid min-w-0 gap-0.5">
          <button
            type="button"
            title={copied ? "Copied" : "Copy path"}
            aria-label={copied ? "Copied" : "Copy path"}
            onClick={async () => {
              await navigator.clipboard.writeText(directoryPath);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="work-toolbar-action work-toolbar-menu-action"
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />}
            <span aria-live="polite">{copied ? "Copied" : "Copy path"}</span>
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
            showLabels
          />
        </div>
      </details>
    </div>
  );
}