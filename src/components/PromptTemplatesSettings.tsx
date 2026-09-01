"use client";

import { useRef, useState } from "react";
import { FileUp, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import {
  parsePromptTemplateFile,
  PROMPT_TEMPLATE_FILE_ACCEPT,
} from "@/lib/prompt-templates";

interface PromptTemplate {
  id: string;
  name: string;
  description: string | null;
  content: string;
}

const EMPTY_FORM = { name: "", description: "", content: "" };

export default function PromptTemplatesSettings({
  initialTemplates,
}: {
  initialTemplates: PromptTemplate[];
}) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setNotice(null);
  }

  async function importFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const imported = parsePromptTemplateFile(file.name, await file.text());
      setEditingId(null);
      setForm({ name: imported.name, description: "", content: imported.content });
      setNotice(`Loaded ${file.name}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        editingId ? `/api/prompt-templates/${editingId}` : "/api/prompt-templates",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Failed to save template");
      }
      setTemplates((current) => {
        const next = editingId
          ? current.map((template) => (template.id === editingId ? body : template))
          : [...current, body];
        return next.sort((left, right) => left.name.localeCompare(right.name));
      });
      resetForm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove(template: PromptTemplate) {
    if (!window.confirm(`Delete the "${template.name}" template?`)) return;
    setError(null);
    const response = await fetch(`/api/prompt-templates/${template.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(typeof body.error === "string" ? body.error : "Failed to delete template");
      return;
    }
    setTemplates((current) => current.filter((item) => item.id !== template.id));
    if (editingId === template.id) resetForm();
  }

  return (
    <div className="space-y-3">
      <form onSubmit={save} className="ui-panel overflow-hidden">
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <label className="text-xs text-neutral-400">
            Name
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Release checklist"
              required
              maxLength={80}
              className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs text-neutral-400">
            Description
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Optional picker tooltip"
              maxLength={240}
              className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
            />
          </label>
        <label className="block text-xs text-neutral-400 sm:col-span-2">
          Prompt
          <textarea
            value={form.content}
            onChange={(event) => setForm({ ...form, content: event.target.value })}
            placeholder="Enter reusable prompt content..."
            required
            rows={7}
            className="ui-input mt-1.5 min-h-44 w-full resize-y px-3 py-2 font-mono text-sm leading-6"
          />
        </label>
        {error && <p role="alert" className="text-sm text-red-400 sm:col-span-2">{error}</p>}
        {notice && <p aria-live="polite" className="text-sm text-emerald-400 sm:col-span-2">{notice}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800 bg-neutral-950/30 px-4 py-3 sm:px-5">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={PROMPT_TEMPLATE_FILE_ACCEPT}
              onChange={(event) => void importFile(event)}
              aria-label="Import prompt template file"
              className="sr-only"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || importing}
              title="Import a Markdown or plain-text file"
              className="ui-secondary-button"
            >
              <FileUp size={15} aria-hidden="true" />
              {importing ? "Importing..." : "Import file"}
            </button>
          </div>
          <div className="flex gap-2">
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                aria-label="Cancel editing"
                title="Cancel editing"
                className="grid size-9 place-items-center rounded-md border border-neutral-700 text-neutral-400 hover:bg-neutral-800 hover:text-white"
              >
                <X size={15} aria-hidden="true" />
              </button>
            )}
            <button
              type="submit"
              disabled={busy || importing}
              className="ui-primary-button"
            >
              {editingId ? <Save size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
              {busy ? "Saving..." : editingId ? "Save changes" : "Add template"}
            </button>
          </div>
        </div>
      </form>

      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/50">
        {templates.map((template) => (
          <div key={template.id} className="flex items-start justify-between gap-4 border-t border-neutral-800 px-4 py-3 first:border-0 hover:bg-neutral-800/30">
            <div className="min-w-0">
              <div className="text-sm font-medium">{template.name}</div>
              <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-neutral-500">
                {template.description || template.content}
              </div>
            </div>
            <div className="flex shrink-0 gap-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  setEditingId(template.id);
                  setForm({
                    name: template.name,
                    description: template.description ?? "",
                    content: template.content,
                  });
                  setError(null);
                  setNotice(null);
                }}
                aria-label={`Edit ${template.name}`}
                title="Edit template"
                className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-white"
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void remove(template)}
                aria-label={`Remove ${template.name}`}
                title="Remove template"
                className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-red-950/60 hover:text-red-300"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
        {templates.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-neutral-500">No custom templates.</p>
        )}
      </div>
    </div>
  );
}