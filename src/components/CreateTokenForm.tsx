"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Plus } from "lucide-react";

export default function CreateTokenForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setToken(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ? JSON.stringify(body.error) : "Failed");
      setToken(body.token);
      setName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="ui-panel space-y-3 p-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          className="ui-input min-w-0 flex-1 px-3 py-2 text-sm"
          placeholder="Token name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button
          type="submit"
          disabled={submitting}
          className="ui-primary-button shrink-0"
        >
          <Plus size={15} aria-hidden="true" />
          {submitting ? "Creating..." : "Create token"}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {token && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/50 p-3 text-xs">
          <p className="mb-1 text-emerald-300">
            <KeyRound size={14} className="mr-1 inline" aria-hidden="true" />
            Save this token now — it won&apos;t be shown again. Use it as{" "}
            <code>Authorization: Bearer &lt;token&gt;</code> against{" "}
            <code>POST /api/external/trigger</code>.
          </p>
          <code className="break-all text-neutral-200">{token}</code>
        </div>
      )}
    </form>
  );
}
