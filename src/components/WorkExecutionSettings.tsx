"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Save, SlidersHorizontal } from "lucide-react";
import WorkExecutionFields, {
  type WorkExecutionSettingsValue,
  workExecutionSettingsPayload,
} from "@/components/WorkExecutionFields";

export default function WorkExecutionSettings({
  workId,
  initialValue,
}: {
  workId: string;
  initialValue: WorkExecutionSettingsValue;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch(`/api/works/${workId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workExecutionSettingsPayload(value)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to save settings");
      }
      setSaved(true);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="ui-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3.5 sm:px-5">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-md bg-neutral-800 text-neutral-300">
            <SlidersHorizontal size={16} aria-hidden="true" />
          </span>
          <h2 className="text-sm font-bold">Execution settings</h2>
        </div>
        {saved && (
          <span aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
            <Check size={13} aria-hidden="true" />
            Saved
          </span>
        )}
      </div>
      <div className="p-4 sm:p-5">
        <WorkExecutionFields value={value} onChange={(nextValue) => {
          setValue(nextValue);
          setSaved(false);
        }} />
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
      <div className="flex justify-end border-t border-neutral-800 bg-neutral-950/30 px-4 py-3 sm:px-5">
        <button type="submit" disabled={saving} className="ui-primary-button">
          <Save size={15} aria-hidden="true" />
          {saving ? "Saving..." : "Save settings"}
        </button>
      </div>
    </form>
  );
}