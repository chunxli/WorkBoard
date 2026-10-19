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
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      <FollowUpDialog
        workId={workId}
        mode={followUpMode}
        disabledReason={followUpDisabledReason}
        inline
      />
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(directoryPath);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="ui-secondary-button"
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />}
        {copied ? "Copied" : "Copy path"}
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