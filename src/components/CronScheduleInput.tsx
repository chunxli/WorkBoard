"use client";

import { useState } from "react";
import { CRON_PRESETS } from "@/lib/cron-presets";

/** Cron picker: a friendly preset dropdown that hides raw cron syntax unless the user opts into "custom". */
export default function CronScheduleInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const matchedPreset = CRON_PRESETS.find((p) => p.value === value);
  const [customMode, setCustomMode] = useState(!matchedPreset);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-medium text-neutral-400">
        Schedule
        <select
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
          value={customMode ? "custom" : matchedPreset?.value ?? "custom"}
          onChange={(event) => {
            if (event.target.value === "custom") {
              setCustomMode(true);
            } else {
              setCustomMode(false);
              onChange(event.target.value);
            }
          }}
        >
          {CRON_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>{preset.label}</option>
          ))}
          <option value="custom">自定义 cron 表达式...</option>
        </select>
      </label>
      {customMode && (
        <label className="text-xs font-medium text-neutral-400">
          Cron expression
          <input
            className="ui-input mt-1.5 w-full px-3 py-2 font-mono text-sm"
            placeholder="0 9 * * 1-5"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
          />
        </label>
      )}
    </div>
  );
}
