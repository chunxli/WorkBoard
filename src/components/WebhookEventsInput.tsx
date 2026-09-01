"use client";

import { COMMON_WEBHOOK_EVENTS } from "@/lib/cron-presets";

/** Checkbox group for common GitHub webhook events, stored as a comma-separated string to match the API. */
export default function WebhookEventsInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  function toggle(event: string) {
    const next = selected.includes(event)
      ? selected.filter((e) => e !== event)
      : [...selected, event];
    onChange(next.join(","));
  }

  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-neutral-400">Webhook events</legend>
      <div className="flex flex-wrap gap-2">
      {COMMON_WEBHOOK_EVENTS.map((event) => (
        <label key={event} className="flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-950/35 px-3 py-2 text-xs text-neutral-300 hover:border-neutral-600">
          <input
            type="checkbox"
            className="size-3.5 accent-emerald-500"
            checked={selected.includes(event)}
            onChange={() => toggle(event)}
          />
          {event}
        </label>
      ))}
      </div>
    </fieldset>
  );
}
