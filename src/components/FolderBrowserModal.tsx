"use client";

import { createPortal } from "react-dom";
import { useEffect, useId, useState } from "react";
import { ArrowUp, Check, Folder, FolderPlus, HardDrive, X } from "lucide-react";
import CreateFolderControl from "@/components/CreateFolderControl";

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  current: string | null;
  parent: string | null;
  entries: BrowseEntry[];
  roots: BrowseEntry[];
  error?: string;
}

export default function FolderBrowserModal({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const titleId = useId();
  const portalTarget = typeof document === "undefined" ? null : document.body;

  async function load(dirPath?: string) {
    setLoading(true);
    setCreatingFolder(false);
    try {
      const url = dirPath ? `/api/fs/browse?path=${encodeURIComponent(dirPath)}` : "/api/fs/browse";
      const res = await fetch(url);
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const id = setTimeout(() => load(), 0);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/75 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ui-panel flex h-[min(42rem,calc(100dvh-1.5rem))] w-full max-w-lg flex-col overflow-hidden shadow-2xl shadow-black/60 sm:h-[min(42rem,calc(100dvh-3rem))]"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3.5">
          <h3 id={titleId} className="flex items-center gap-2 text-sm font-bold">
            <Folder size={16} className="text-emerald-400" aria-hidden="true" />
            选择本地文件夹
          </h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCreatingFolder((current) => !current)}
              disabled={loading || !data?.current || Boolean(data.error)}
              aria-label="在当前目录创建文件夹"
              aria-expanded={creatingFolder}
              title="创建文件夹"
              className={`grid size-8 place-items-center rounded-md disabled:opacity-40 ${
                creatingFolder
                  ? "bg-emerald-950/60 text-emerald-300"
                  : "text-neutral-500 hover:bg-neutral-800 hover:text-white"
              }`}
            >
              <FolderPlus size={15} aria-hidden="true" />
            </button>
            <button onClick={onClose} aria-label="关闭" title="关闭" className="grid size-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-white">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-4">

        <p className="mb-3 truncate rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-300">
          {data?.current ?? "..."}
        </p>

        {creatingFolder && data?.current && (
          <div className="mb-3 overflow-hidden rounded-md border border-neutral-800">
            <CreateFolderControl
              parentPath={data.current}
              onCancel={() => setCreatingFolder(false)}
              onCreated={onSelect}
            />
          </div>
        )}

        <div className="mb-2 flex flex-wrap gap-1.5">
          {data?.roots.map((root) => (
            <button
              key={root.path}
              onClick={() => load(root.path)}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              <HardDrive size={13} aria-hidden="true" />
              {root.name}
            </button>
          ))}
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/40">
          {loading && <p className="p-3 text-sm text-neutral-500">加载中...</p>}
          {!loading && data?.error && <p className="p-3 text-sm text-red-400">{data.error}</p>}
          {!loading && data && !data.error && (
            <ul className="divide-y divide-neutral-800 text-sm">
              {data.parent && (
                <li>
                  <button
                    onClick={() => load(data.parent!)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-neutral-300 hover:bg-neutral-800"
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                    上一级
                  </button>
                </li>
              )}
              {data.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    onClick={() => load(entry.path)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-neutral-800"
                  >
                    <Folder size={14} className="text-emerald-500" aria-hidden="true" />
                    {entry.name}
                  </button>
                </li>
              ))}
              {data.entries.length === 0 && !data.parent && (
                <li className="px-3 py-2 text-neutral-500">空文件夹</li>
              )}
            </ul>
          )}
        </div>

        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-800 bg-neutral-950/30 px-4 py-3">
          <button
            onClick={onClose}
            className="ui-secondary-button"
          >
            取消
          </button>
          <button
            onClick={() => data?.current && onSelect(data.current)}
            disabled={!data?.current}
            className="ui-primary-button"
          >
            <Check size={15} aria-hidden="true" />
            使用此文件夹
          </button>
        </div>
      </div>
    </div>,
    portalTarget
  );
}
