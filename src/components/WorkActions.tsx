"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, Clipboard, RotateCcw } from "lucide-react";
import FollowUpDialog from "@/components/FollowUpDialog";

export default function WorkActions({
  workId,
  directoryPath,
  archived,
  followUpMode,
  followUpDisabledReason,
}: {
  workId: string;
  directoryPath: string;
  archived: boolean;
  followUpMode: "resume" | "new";
  followUpDisabledReason?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setArchived(nextArchived: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/works/${workId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextArchived ? "ARCHIVED" : "ACTIVE" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Failed to update Work");
      if (nextArchived) router.push("/work");
      else router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <FollowUpDialog
        workId={workId}
        mode={followUpMode}
        disabledReason={followUpDisabledReason}
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
      <button
        type="button"
        disabled={busy}
        onClick={() => void setArchived(!archived)}
        className="ui-secondary-button"
      >
        {archived ? <RotateCcw size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
        {archived ? "Restore" : "Complete & archive"}
      </button>
      {error && <span role="alert" className="self-center text-xs text-red-400">{error}</span>}
    </div>
  );
}