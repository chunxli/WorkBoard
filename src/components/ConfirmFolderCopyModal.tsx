"use client";

import { createPortal } from "react-dom";
import { useEffect, useId } from "react";
import { ArrowRight, Copy, Folder, TriangleAlert, X } from "lucide-react";

export default function ConfirmFolderCopyModal({
  sourcePath,
  onConfirm,
  onCancel,
}: {
  sourcePath: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const portalTarget = typeof document === "undefined" ? null : document.body;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel]);

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ui-panel w-full max-w-md overflow-hidden shadow-2xl shadow-black/40"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3.5 sm:px-5">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-bold text-neutral-100">
            <Copy size={16} className="text-emerald-400" aria-hidden="true" />
            Copy selected folder?
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel folder copy"
            title="Cancel"
            className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-white"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          <div className="rounded-md border border-neutral-800 bg-neutral-950/55 p-3">
            <p className="mb-2 text-[10px] font-bold uppercase text-neutral-500">Source folder</p>
            <div className="flex min-w-0 items-start gap-2">
              <Folder size={15} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
              <p className="break-all font-mono text-xs leading-5 text-neutral-300">{sourcePath}</p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-md border border-amber-900/70 bg-amber-950/35 p-3 text-xs leading-5 text-amber-200">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
            <p>
              A complete sibling copy will be created with the next numeric suffix, such as
              <span className="font-mono"> -2</span>, <span className="font-mono"> -3</span>, and so on.
              Large folders may take some time.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-800 bg-neutral-950/30 px-4 py-3 sm:px-5">
          <button type="button" onClick={onCancel} className="ui-secondary-button">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="ui-primary-button">
            <Copy size={15} aria-hidden="true" />
            Create copy
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>,
    portalTarget
  );
}
