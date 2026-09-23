"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { getRunStatusLabel } from "@/lib/work-run-status";

interface SearchResults {
  works: { id: string; name: string }[];
  repos: { id: string; name: string }[];
  tasks: { id: string; name: string }[];
  runs: { id: string; status: string; task: { name: string } | null; work: { name: string } | null }[];
}

const EMPTY: SearchResults = { works: [], repos: [], tasks: [], runs: [] };

export default function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    const controller = new AbortController();
    const handle = setTimeout(() => {
      if (trimmed.length < 2) {
        setResults(EMPTY);
        return;
      }
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) setResults(data);
        })
        .catch(() => {});
    }, 250);
    // Cancels both the pending debounce timer and any in-flight request from a stale query,
    // so a fast-typed later query can never be overwritten by an earlier one's late response.
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        containerRef.current?.querySelector("input")?.focus();
      }
    }
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);

  const hasResults =
    results.works.length + results.repos.length + results.tasks.length + results.runs.length > 0;

  function goTo(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <Search
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
      />
      <input
        aria-label="Global search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search work, resources, runs..."
        className="h-9 w-full rounded-md border border-neutral-700 bg-neutral-950/70 py-1.5 pl-9 pr-16 text-sm text-neutral-200 shadow-inner shadow-black/10 placeholder:text-neutral-600 hover:border-neutral-600 focus:border-emerald-700"
      />
      {!query && (
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[9px] text-neutral-500 xl:inline-flex">
          Ctrl K
        </kbd>
      )}
      {query && (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setResults(EMPTY);
          }}
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-white"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
      {open && query.trim().length >= 2 && (
        <div className="absolute right-0 z-50 mt-2 w-full overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900/95 p-2 text-sm shadow-2xl shadow-black/50 backdrop-blur-xl sm:w-96">
          {!hasResults && <p className="px-3 py-5 text-center text-neutral-500">No matches.</p>}
          {results.works.length > 0 && (
            <div className="mb-1">
              <p className="px-2 py-1.5 text-[11px] font-bold uppercase text-neutral-500">Work</p>
              {results.works.map((work) => (
                <button
                  key={work.id}
                  onClick={() => goTo(`/work/${work.id}`)}
                  className="block w-full rounded-md px-2 py-2 text-left text-neutral-200 hover:bg-neutral-800"
                >
                  {work.name}
                </button>
              ))}
            </div>
          )}
          {results.repos.length > 0 && (
            <div className="mb-1">
              <p className="px-2 py-1.5 text-[11px] font-bold uppercase text-neutral-500">Resources</p>
              {results.repos.map((r) => (
                <button
                  key={r.id}
                  onClick={() => goTo(`/tasks/new?resource=${encodeURIComponent(r.id)}`)}
                  className="block w-full rounded-md px-2 py-2 text-left text-neutral-200 hover:bg-neutral-800"
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
          {results.tasks.length > 0 && (
            <div className="mb-1">
              <p className="px-2 py-1.5 text-[11px] font-bold uppercase text-neutral-500">Automations</p>
              {results.tasks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => goTo(`/tasks/${t.id}`)}
                  className="block w-full rounded-md px-2 py-2 text-left text-neutral-200 hover:bg-neutral-800"
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {results.runs.length > 0 && (
            <div>
              <p className="px-2 py-1.5 text-[11px] font-bold uppercase text-neutral-500">Runs</p>
              {results.runs.map((r) => (
                <button
                  key={r.id}
                  onClick={() => goTo(`/runs/${r.id}`)}
                  className="block w-full rounded-md px-2 py-2 text-left text-neutral-200 hover:bg-neutral-800"
                >
                  {r.work?.name ?? r.task?.name ?? "Unknown"} · {r.id.slice(0, 8)} ({getRunStatusLabel(r.status)})
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
