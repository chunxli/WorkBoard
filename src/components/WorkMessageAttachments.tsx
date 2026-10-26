"use client";

import { useEffect, useRef, useState } from "react";
import { FilePlus2, Paperclip, X } from "lucide-react";
import Image from "next/image";
import {
  MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS,
  attachmentHref, workAttachmentSchema, type WorkAttachment,
} from "@/lib/work-attachment-types";

interface DraftFile { id: string; file: File; thumbnail: string | null; receipt?: WorkAttachment; progress: number; error?: string }

export function MessageAttachments({ workId, files }: { workId: string; files: WorkAttachment[] }) {
  if (!files.length) return null;
  return <div className="flex flex-wrap gap-2" aria-label="Message attachments">
    {files.map((file) => <a key={file.id} href={attachmentHref(workId, file, !file.mediaType.startsWith("image/"))}
      target="_blank" rel="noopener noreferrer" title={`${file.name} · ${(file.size / 1024).toFixed(1)} KiB`}
      className="flex max-w-60 items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900/60 px-2 py-1 text-xs text-neutral-300 hover:text-emerald-300">
      {file.mediaType.startsWith("image/") ? <Image unoptimized width={80} height={64} src={attachmentHref(workId, file)} alt={file.name} className="max-h-16 max-w-20 rounded object-contain" />
        : <Paperclip size={13} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 truncate">{file.name}</span>
    </a>)}
  </div>;
}

export function useMessageAttachments(workId: string) {
  const [files, setFiles] = useState<DraftFile[]>([]);
  const current = useRef<DraftFile[]>([]);
  const active = useRef<XMLHttpRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const replace = (next: DraftFile[]) => { current.current = next; if (mounted.current) setFiles(next); };
  const update = (id: string, changes: Partial<DraftFile>) => replace(current.current.map((file) => file.id === id ? { ...file, ...changes } : file));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      current.current.forEach((file) => { if (file.thumbnail) URL.revokeObjectURL(file.thumbnail); });
    };
  }, []);

  function add(items: File[]) {
    if (!items.length) return;
    const all = [...current.current.map((entry) => entry.file), ...items];
    if (all.length > MAX_MESSAGE_ATTACHMENTS || all.some((file) => file.size > MAX_ATTACHMENT_BYTES) ||
      all.reduce((total, file) => total + file.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
      setError("Use at most 10 files, 25 MiB per file and 100 MiB total.");
      return;
    }
    setError(null);
    replace([...current.current, ...items.map((file) => ({
      id: window.crypto.randomUUID(), file, progress: 0,
      thumbnail: ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) ? URL.createObjectURL(file) : null,
    }))]);
  }
  function remove(id: string) {
    const file = current.current.find((entry) => entry.id === id);
    if (file?.thumbnail) URL.revokeObjectURL(file.thumbnail);
    replace(current.current.filter((entry) => entry.id !== id));
    setError(null);
  }
  function clear() {
    current.current.forEach((file) => { if (file.thumbnail) URL.revokeObjectURL(file.thumbnail); });
    replace([]); setError(null);
  }
  async function upload(requestId: string): Promise<WorkAttachment[]> {
    const selected = [...current.current];
    const receipts: WorkAttachment[] = [];
    for (const entry of selected) {
      if (entry.receipt?.requestId === requestId) { receipts.push(entry.receipt); continue; }
      const query = new URLSearchParams({
        requestId, uploadId: entry.id, name: entry.file.name || `pasted-image-${entry.id}.png`, size: String(entry.file.size),
      });
      update(entry.id, { progress: 0, error: undefined });
      try {
        const receipt = await new Promise<WorkAttachment>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          active.current = xhr;
          xhr.open("POST", `/api/works/${encodeURIComponent(workId)}/attachments?${query}`);
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          xhr.timeout = 120_000;
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) update(entry.id, { progress: Math.floor(event.loaded / event.total * 100) });
          };
          xhr.onerror = () => reject(new Error("Attachment upload failed. Retry this same draft."));
          xhr.onabort = () => reject(new Error("Attachment upload cancelled."));
          xhr.ontimeout = () => reject(new Error("Attachment upload timed out. Retry this same draft."));
          xhr.onload = () => {
            let body: { attachment?: unknown; error?: unknown };
            try { body = JSON.parse(xhr.responseText); }
            catch { reject(new Error("The upload server returned an invalid response.")); return; }
            if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(typeof body.error === "string" ? body.error : "Attachment upload failed.")); return; }
            const parsed = workAttachmentSchema.safeParse(body.attachment);
            if (!parsed.success || parsed.data.requestId !== requestId || parsed.data.uploadId !== entry.id) {
              reject(new Error("The upload receipt does not match this file.")); return;
            }
            resolve(parsed.data);
          };
          xhr.send(entry.file);
        });
        receipts.push(receipt);
        update(entry.id, { receipt, progress: 100 });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "Attachment upload failed.";
        update(entry.id, { error: message });
        throw reason;
      } finally { active.current = null; }
    }
    if (receipts.length) window.dispatchEvent(new CustomEvent("workboard:files-updated", { detail: { workId } }));
    return receipts;
  }
  return { files, add, remove, clear, upload, error };
}

export function AttachmentDraft({ files, disabled, error, add, remove }: {
  files: DraftFile[]; disabled: boolean; error: string | null; add: (files: File[]) => void; remove: (id: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return <div className="space-y-1">
    <input ref={picker} type="file" multiple hidden aria-label="Choose message attachments" disabled={disabled}
      onChange={(event) => { add([...event.currentTarget.files ?? []]); event.currentTarget.value = ""; }} />
    <button type="button" disabled={disabled} onClick={() => picker.current?.click()}
      title="Paste images, drop files, or select up to 10 files; 25 MiB each, 100 MiB total."
      className="work-toolbar-action inline-flex min-h-8 items-center gap-1 text-xs disabled:opacity-50">
      <FilePlus2 size={14} aria-hidden="true" />Add files
    </button>
    {files.length > 0 && <ul className="flex max-h-28 flex-wrap gap-1 overflow-auto" aria-label="Attachments to send">
      {files.map((entry) => <li key={entry.id} className="flex max-w-64 items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs">
        {entry.thumbnail && <Image unoptimized width={48} height={40} src={entry.thumbnail} alt="" className="max-h-10 max-w-12 rounded object-contain" />}
        <span className="min-w-0" title={entry.file.name}>
          <span className="block truncate text-neutral-300">{entry.file.name || "Pasted image"}</span>
          <span className={entry.error ? "text-red-400" : "text-neutral-400"} role={entry.error ? "alert" : undefined}>
            {entry.error ?? `${(entry.file.size / 1024).toFixed(1)} KiB${entry.progress ? ` · ${entry.progress}% uploaded` : ""}`}
          </span>
        </span>
        <button type="button" disabled={disabled} aria-label={`Remove ${entry.file.name || "pasted image"}`} onClick={() => remove(entry.id)}
          className="grid size-8 shrink-0 place-items-center rounded text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"><X size={12} aria-hidden="true" /></button>
      </li>)}
    </ul>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </div>;
}
