"use client";

import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

export default function DeleteButton({ url, label = "Delete" }: { url: string; label?: string }) {
  const router = useRouter();

  async function onClick() {
    if (!confirm("Are you sure?")) return;
    await fetch(url, { method: "DELETE" });
    router.refresh();
  }

  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-red-900/70 px-2.5 py-1 text-xs text-red-400 hover:border-red-800 hover:bg-red-950/60"
    >
      <Trash2 size={13} aria-hidden="true" />
      {label}
    </button>
  );
}
