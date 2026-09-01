"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LegacyMigrationPanel({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function migrate() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/works/migrate-legacy", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? body.failed?.[0]?.error ?? "Migration failed");
      }
      const failed = Array.isArray(body.failed) ? body.failed.length : 0;
      setMessage(
        failed > 0
          ? `Migrated ${body.migrated.length}; ${failed} need attention.`
          : `Migrated ${body.migrated.length} automations.`
      );
      router.refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (count === 0) return null;
  return (
    <div className="flex flex-col justify-between gap-3 border-y border-amber-800 bg-amber-950/20 px-4 py-3 sm:flex-row sm:items-center">
      <div>
        <p className="text-sm font-medium text-amber-200">{count} existing automations are not on the Work Board.</p>
        <p className="text-xs text-amber-400/80">Their resource directory is reused; prompts receive numbered file names.</p>
        {message && <p aria-live="polite" className="mt-1 text-xs text-neutral-300">{message}</p>}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void migrate()}
        className="shrink-0 rounded border border-amber-600 px-3 py-2 text-sm text-amber-100 hover:bg-amber-900/40 disabled:opacity-50"
      >
        {busy ? "Migrating..." : "Migrate to Work"}
      </button>
    </div>
  );
}