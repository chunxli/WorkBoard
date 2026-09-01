"use client";

import { useState } from "react";
import { Check, RotateCcw, Save } from "lucide-react";
import WorkExecutionFields from "@/components/WorkExecutionFields";
import {
  BUILT_IN_EXECUTION_DEFAULTS,
  executionDefaultsPayload,
  type ExecutionDefaultsValue,
  workExecutionSettingsValue,
} from "@/lib/execution-defaults";

export default function ExecutionDefaultsSettings({
  initialValue,
}: {
  initialValue: ExecutionDefaultsValue;
}) {
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
      const response = await fetch("/api/execution-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(executionDefaultsPayload(value)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to save defaults");
      }
      setValue(body as ExecutionDefaultsValue);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="ui-panel overflow-hidden">
      <div className="border-b border-neutral-800 px-4 py-3 sm:px-5">
        <p className="text-xs leading-5 text-neutral-500">
          Applied when creating a new Work or Automation. Existing items keep their saved settings.
        </p>
      </div>
      <div className="space-y-5 p-4 sm:p-5">
        <div>
          <h3 className="mb-3 text-xs font-bold uppercase text-neutral-400">Work and shared defaults</h3>
          <WorkExecutionFields
            value={workExecutionSettingsValue(value)}
            keepCliFieldsEnabled
            onChange={(workValue) => {
              const { timeoutSeconds, ...sharedValue } = workValue;
              setValue((current) => ({
                ...current,
                ...sharedValue,
                workTimeoutSeconds: timeoutSeconds,
              }));
              setSaved(false);
            }}
          />
        </div>
        <div className="border-t border-neutral-800 pt-5">
          <h3 className="mb-3 text-xs font-bold uppercase text-neutral-400">Automation only</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs text-neutral-400">
              Timeout (seconds)
              <input
                type="number"
                min={30}
                max={86400}
                value={value.automationTimeoutSeconds}
                onChange={(event) => {
                  setValue({ ...value, automationTimeoutSeconds: Number(event.target.value) });
                  setSaved(false);
                }}
                className="ui-input mt-1.5 w-full px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="flex items-center gap-3 self-end rounded-md border border-neutral-800 bg-neutral-950/30 p-3 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={value.useSafeBranch}
                onChange={(event) => {
                  setValue({ ...value, useSafeBranch: event.target.checked });
                  setSaved(false);
                }}
                className="size-4 accent-emerald-500"
              />
              Create safe branch
            </label>
            <label className="flex items-center gap-3 self-end rounded-md border border-neutral-800 bg-neutral-950/30 p-3 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={value.waitForPreviousRuns}
                onChange={(event) => {
                  setValue({ ...value, waitForPreviousRuns: event.target.checked });
                  setSaved(false);
                }}
                className="size-4 accent-emerald-500"
              />
              Wait for earlier Runs
            </label>
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800 bg-neutral-950/30 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={() => {
            setValue({ ...BUILT_IN_EXECUTION_DEFAULTS });
            setSaved(false);
            setError(null);
          }}
          className="ui-secondary-button"
        >
          <RotateCcw size={14} aria-hidden="true" />
          Reset fields
        </button>
        <div className="flex items-center gap-3">
          {saved && (
            <span aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
              <Check size={13} aria-hidden="true" /> Saved
            </span>
          )}
          <button type="submit" disabled={saving} className="ui-primary-button">
            <Save size={15} aria-hidden="true" />
            {saving ? "Saving..." : "Save defaults"}
          </button>
        </div>
      </div>
    </form>
  );
}