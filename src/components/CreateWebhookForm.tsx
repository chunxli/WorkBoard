"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Repo } from "@/generated/prisma/client";
import { Plus, Webhook } from "lucide-react";

export default function CreateWebhookForm({ repos }: { repos: Repo[] }) {
  const router = useRouter();
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [result, setResult] = useState<{ secret: string; repoId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ? JSON.stringify(body.error) : "Failed");
      setResult(body);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (repos.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-800 p-4 text-sm text-neutral-500">
        Add a Resource in{" "}
        <Link href="/tasks/new" className="font-semibold text-emerald-400 hover:text-emerald-300">
          New Automation
        </Link>
        {" "}first.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="ui-panel space-y-3 p-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <select
          className="ui-input min-w-0 flex-1 px-3 py-2 text-sm"
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={submitting}
          className="ui-primary-button shrink-0"
        >
          <Plus size={15} aria-hidden="true" />
          {submitting ? "Creating..." : "Generate webhook"}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {result && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/50 p-3 text-xs">
          <p className="mb-1 text-emerald-300">
            <Webhook size={14} className="mr-1 inline" aria-hidden="true" />
            Save this secret now — it won&apos;t be shown again. Configure your GitHub webhook to
            POST to <code>/api/webhooks/github/{result.repoId}</code> with content type
            application/json.
          </p>
          <code className="break-all text-neutral-200">{result.secret}</code>
        </div>
      )}
    </form>
  );
}
