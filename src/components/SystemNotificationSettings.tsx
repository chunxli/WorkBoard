"use client";

import { useState } from "react";
import { BellRing, Check, LoaderCircle, Save } from "lucide-react";

export default function SystemNotificationSettings({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/notification-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.enabled !== "boolean") {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to save notification settings"
        );
      }
      setEnabled(body.enabled);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function sendTestNotification() {
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/notifications/test", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        throw new Error(
          typeof body.error === "string" ? body.error : "Failed to send test notification"
        );
      }
      setMessage("Test notification sent");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={save} className="ui-panel overflow-hidden">
      <div className="space-y-4 p-4 sm:p-5">
        <label className="flex items-start gap-3 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              setSaved(false);
              setMessage(null);
            }}
            className="mt-0.5 size-4 accent-emerald-500"
          />
          <span>
            <span className="block font-semibold text-neutral-200">System notifications</span>
            <span className="mt-1 block text-xs leading-5 text-neutral-500">
              Notify on successful, failed, and timed-out Work or Automation Runs. Experiments send one aggregate notification.
            </span>
          </span>
        </label>
        <p className="text-xs leading-5 text-neutral-500">
          Notifications appear on the machine running the Work Board background process, even when browser tabs are closed.
        </p>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-950/30 px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={() => void sendTestNotification()}
          disabled={testing || saving}
          className="ui-secondary-button"
        >
          {testing ? (
            <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <BellRing size={14} aria-hidden="true" />
          )}
          {testing ? "Sending..." : "Send test notification"}
        </button>
        <div className="flex items-center gap-3">
          {(saved || message) && (
            <span aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
              <Check size={13} aria-hidden="true" /> {message ?? "Saved"}
            </span>
          )}
          <button type="submit" disabled={saving || testing} className="ui-primary-button">
            <Save size={15} aria-hidden="true" />
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}
