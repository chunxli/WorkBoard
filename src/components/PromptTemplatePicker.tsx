"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Settings2, Sparkles } from "lucide-react";
import {
  applyPromptTemplate,
  BUILT_IN_PROMPT_TEMPLATES,
  type PromptTemplateOption,
} from "@/lib/prompt-templates";

export default function PromptTemplatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [customTemplates, setCustomTemplates] = useState<PromptTemplateOption[]>([]);
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/prompt-templates")
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error("Custom templates unavailable");
        if (active) {
          setCustomTemplates(
            body.map((template: PromptTemplateOption) => ({ ...template, builtIn: false }))
          );
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const templates = [...BUILT_IN_PROMPT_TEMPLATES, ...customTemplates];

  return (
    <div className="space-y-2.5 rounded-md border border-neutral-800 bg-neutral-950/45 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold text-neutral-300">
          <Sparkles size={13} className="text-emerald-400" aria-hidden="true" />
          Quick templates
        </span>
        <div className="flex items-center gap-2 text-xs">
          <select
            aria-label="Template apply mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as "append" | "replace")}
            className="h-7 rounded border border-neutral-700 bg-neutral-900 px-2 text-[11px] text-neutral-300"
          >
            <option value="append">Append</option>
            <option value="replace">Replace</option>
          </select>
          <Link href="/settings#prompt-templates" className="flex items-center gap-1 text-neutral-500 hover:text-white">
            <Settings2 size={12} aria-hidden="true" />
            Manage
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {templates.map((template) => (
          <button
            type="button"
            key={template.id}
            title={template.description ?? template.name}
            onClick={() =>
              onChange(
                mode === "replace" ? template.content : applyPromptTemplate(value, template.content)
              )
            }
            className={`rounded-md border px-2.5 py-1.5 text-[11px] font-medium hover:-translate-y-px hover:text-white ${
              template.builtIn
                ? "border-neutral-700/80 bg-neutral-900 text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800"
                : "border-emerald-800/80 bg-emerald-950/30 text-emerald-300 hover:border-emerald-700 hover:bg-emerald-950/60"
            }`}
          >
            {template.name}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-amber-500">{error}</p>}
    </div>
  );
}