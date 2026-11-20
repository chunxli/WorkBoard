"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { caseIqMcpDefaultsStatusSchema, type CaseIqMcpDefaults } from "@/lib/caseiq-options";

export default function CaseIqMcpDefaultsSettings() {
  const [value, setValue] = useState<CaseIqMcpDefaults | null>(null);
  const [knownServers, setKnownServers] = useState<string[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const savingRef = useRef(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++requestVersion.current;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true); setError(null); setNotice(null);
      const response = await fetch("/api/caseiq/mcp-defaults", { cache: "no-store", signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error("MCP defaults could not be loaded. Inspect local diagnostics.");
      const parsed = caseIqMcpDefaultsStatusSchema.safeParse(body);
      if (!parsed.success) throw new Error("The MCP defaults response is invalid.");
      if (!controller.signal.aborted && requestVersion.current === version) {
        setValue(parsed.data.settings); setKnownServers(parsed.data.knownServers); setAvailable(parsed.data.available);
        setBlockedReason(parsed.data.blockedReason); setWarnings(parsed.data.warnings);
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && requestVersion.current === version) setError(reason instanceof Error ? reason.message : "MCP defaults could not be loaded.");
    }).finally(() => { if (!controller.signal.aborted && requestVersion.current === version) setLoading(false); });
    const invalidate = () => { requestVersion.current++; };
    return () => { controller.abort(); invalidate(); };
  }, [revision]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!value || savingRef.current || loading || error || !available) return;
    savingRef.current = true;
    const version = ++requestVersion.current;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/caseiq/mcp-defaults", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = body !== null && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "MCP defaults could not be saved.";
        throw new Error(failure);
      }
      const parsed = caseIqMcpDefaultsStatusSchema.safeParse(body);
      if (!parsed.success) throw new Error("MCP defaults save acceptance is unconfirmed. Refresh before retrying.");
      if (requestVersion.current === version) {
        setValue(parsed.data.settings); setKnownServers(parsed.data.knownServers); setWarnings(parsed.data.warnings);
        setNotice("MCP defaults saved. Existing Work/session configurations were not changed.");
      }
    } catch (reason) {
      if (requestVersion.current === version) setError(`${reason instanceof Error ? reason.message : "MCP defaults save acceptance is unconfirmed."} Refresh defaults before retrying.`);
    } finally { savingRef.current = false; if (requestVersion.current === version) setSaving(false); }
  }

  return <form onSubmit={save} aria-label="CaseIQ MCP defaults" className="ui-panel min-w-0 space-y-4 p-4 [overflow-wrap:anywhere] sm:p-5">
    <p className="text-xs leading-5 text-neutral-500">
      Initial defaults for CaseIQ Work/session configuration on this execution host. Existing saved configurations keep their own settings.
      Each Work can override these defaults in its <Link href="/work" className="text-emerald-400 underline">Work Detail</Link> left panel, under MCP configuration.
    </p>
    {loading && <p role="status" className="text-xs text-neutral-500">Loading MCP defaults...</p>}
    {value && <fieldset disabled={loading || saving || Boolean(error) || !available} className="space-y-4">
      <label className="flex items-start gap-2 text-sm text-neutral-300">
        <input type="checkbox" className="mt-0.5 accent-emerald-500" checked={value.defaultAutoApprove}
          onChange={(event) => { setValue({ ...value, defaultAutoApprove: event.target.checked }); setNotice(null); }} />
        Automatically approve discovered MCPs by default for new CaseIQ Work/sessions
      </label>
      <p className="text-xs text-neutral-500">Automatic approval includes future and write-capable tools of each selected MCP. It does not sign in, bypass organization restrictions, remove original CaseIQ pre-approvals, or replay a Prompt.</p>
      <div className="space-y-2">
        {knownServers.map((serverName) => <label key={serverName} className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-400">
          <span className="min-w-0 break-all font-mono">{serverName}</span>
          <select aria-label={`${serverName} default approval`} className="ui-input max-w-full px-2 py-1 text-xs"
            value={value.servers.find((server) => server.serverName === serverName)?.autoApprove === undefined
              ? "inherit" : value.servers.find((server) => server.serverName === serverName)?.autoApprove ? "automatic" : "manual"}
            onChange={(event) => {
              const next = event.target.value;
              setValue({ ...value, servers: [...value.servers.filter((server) => server.serverName !== serverName),
                ...(next === "inherit" ? [] : [{ serverName, autoApprove: next === "automatic" }])] });
              setNotice(null);
            }}>
            <option value="inherit">Use default ({value.defaultAutoApprove ? "automatic" : "manual"})</option>
            <option value="automatic">Automatic</option>
            <option value="manual">Manual approval</option>
          </select>
        </label>)}
      </div>
    </fieldset>}
    {blockedReason && <p role="status" className="text-xs text-amber-300">{blockedReason}</p>}
    {warnings.map((warning) => <p role="alert" key={warning} className="text-xs text-amber-300">{warning}</p>)}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {notice && <p role="status" className="text-xs text-emerald-400">{notice}</p>}
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button type="button" className="ui-subtle-button" disabled={loading || saving} onClick={() => setRevision((current) => current + 1)}>
        <RefreshCw size={13} aria-hidden="true" />Refresh defaults
      </button>
      <button type="submit" className="ui-primary-button" disabled={!value || loading || saving || Boolean(error) || !available}>
        <Save size={14} aria-hidden="true" />{saving ? "Saving..." : "Save MCP defaults"}
      </button>
    </div>
  </form>;
}
