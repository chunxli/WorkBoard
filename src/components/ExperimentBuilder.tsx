"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import FolderBrowserModal from "@/components/FolderBrowserModal";

interface SkillOption {
  name: string;
  description: string;
  directoryPath: string;
  contentHash: string;
  source: "PROJECT" | "LOCAL";
}

export default function ExperimentBuilder({
  workId,
  initialSkills,
  defaultEngine,
}: {
  workId: string;
  initialSkills: SkillOption[];
  defaultEngine: "CLI" | "SDK";
}) {
  const router = useRouter();
  const [skills, setSkills] = useState(initialSkills);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeBaseline, setIncludeBaseline] = useState(true);
  const [invocationMode, setInvocationMode] = useState<"EXPLICIT" | "AUTO">("EXPLICIT");
  const [engine, setEngine] = useState(defaultEngine);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(path: string) {
    setSelected((current) =>
      current.includes(path) ? current.filter((candidate) => candidate !== path) : [...current, path]
    );
  }

  async function addLocalPath(localPath: string) {
    setBrowsing(false);
    setScanning(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/works/${workId}/skills?localPath=${encodeURIComponent(localPath)}`
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Scan failed");
      const found = body as SkillOption[];
      setSkills((current) => {
        const byPath = new Map(current.map((skill) => [skill.directoryPath, skill]));
        for (const skill of found) byPath.set(skill.directoryPath, skill);
        return [...byPath.values()];
      });
      setSelected((current) => [...new Set([...current, ...found.map((skill) => skill.directoryPath)])]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScanning(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/works/${workId}/experiments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillPaths: selected,
          includeBaseline,
          invocationMode,
          engine,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Experiment failed");
      }
      setSelected([]);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 border-t border-neutral-700 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Skill comparison</h2>
          <p className="text-xs text-neutral-500">Each variant is a complete copy from one frozen base.</p>
        </div>
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          disabled={scanning}
          className="rounded border border-neutral-600 px-3 py-2 text-sm hover:bg-neutral-800 disabled:opacity-50"
        >
          {scanning ? "Scanning..." : "Add local Skills"}
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((skill) => (
          <label
            key={skill.directoryPath}
            className={`block cursor-pointer border p-3 ${
              selected.includes(skill.directoryPath)
                ? "border-emerald-600 bg-emerald-950/20"
                : "border-neutral-700 hover:border-neutral-500"
            }`}
          >
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={selected.includes(skill.directoryPath)}
                onChange={() => toggle(skill.directoryPath)}
                className="mt-1"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>{skill.name}</span>
                  <span className="text-[10px] text-neutral-500">{skill.source}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{skill.description}</p>
                <p className="mt-2 font-mono text-[10px] text-neutral-600">{skill.contentHash.slice(0, 12)}</p>
              </div>
            </div>
          </label>
        ))}
        {skills.length === 0 && (
          <p className="text-sm text-neutral-500">No project Skills found. Add a local Skill directory.</p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4 border-t border-neutral-800 pt-3">
        <label className="flex items-center gap-2 pb-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={includeBaseline}
            onChange={(event) => setIncludeBaseline(event.target.checked)}
          />
          Include no-Skill baseline
        </label>
        <label className="text-xs text-neutral-500">
          Invocation
          <select
            value={invocationMode}
            onChange={(event) => setInvocationMode(event.target.value as "EXPLICIT" | "AUTO")}
            className="mt-1 block rounded border border-neutral-600 bg-neutral-950 px-3 py-2 text-sm text-white"
          >
            <option value="EXPLICIT">Explicit /skill-name</option>
            <option value="AUTO">Automatic matching</option>
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          Engine
          <select
            value={engine}
            onChange={(event) => setEngine(event.target.value as "CLI" | "SDK")}
            className="mt-1 block rounded border border-neutral-600 bg-neutral-950 px-3 py-2 text-sm text-white"
          >
            <option value="CLI">Copilot CLI</option>
            <option value="SDK">Copilot SDK</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || (selected.length === 0 && !includeBaseline)}
          className="ml-auto rounded bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Copying resources..." : `Run ${selected.length + (includeBaseline ? 1 : 0)} variants`}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {browsing && (
        <FolderBrowserModal onClose={() => setBrowsing(false)} onSelect={(path) => void addLocalPath(path)} />
      )}
    </section>
  );
}