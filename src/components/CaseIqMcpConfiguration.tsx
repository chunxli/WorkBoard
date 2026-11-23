"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CaseIqToolPermissionsPanel, useCaseIqToolPermissions } from "@/components/CaseIqToolPermissionsPanel";
import { caseIqMcpSessionIndexSchema, type CaseIqMcpSessionEntry } from "@/lib/caseiq-options";

export default function CaseIqMcpConfiguration({ workId, initialSessionId }: {
  workId: string; initialSessionId: string | null;
}) {
  const scope = JSON.stringify([workId, initialSessionId]);
  const [sessions, setSessions] = useState<CaseIqMcpSessionEntry[]>([]);
  const [selection, setSelection] = useState<{ scope: string; sessionId: string | null }>({ scope, sessionId: null });
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const workSessions = sessions.filter((session) => session.workId === workId);
  const selectedId = selection.scope === scope ? selection.sessionId : initialSessionId;
  const selected = workSessions.find((session) => session.sessionId === selectedId) ?? null;
  const permissions = useCaseIqToolPermissions(workId, selected?.runId ?? null, Boolean(selected?.ready));

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true); setError(null);
      const response = await fetch("/api/caseiq/mcp-sessions", { cache: "no-store", signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error("MCP Work/session configuration could not be loaded.");
      const parsed = caseIqMcpSessionIndexSchema.safeParse(body);
      if (!parsed.success) throw new Error("The MCP session index is invalid.");
      if (!controller.signal.aborted) {
        const owned = parsed.data.sessions.filter((session) => session.workId === workId);
        setSessions(owned);
        setSelection((current) => {
          if (current.scope === scope && owned.some((session) => session.sessionId === current.sessionId)) return current;
          return { scope, sessionId: initialSessionId
            ? owned.find((session) => session.sessionId === initialSessionId)?.sessionId ?? null
            : owned[0]?.sessionId ?? null };
        });
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "MCP sessions could not be loaded.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [initialSessionId, workId, scope, revision]);

  return <section aria-label="Work MCP configuration" className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold text-neutral-200">MCP configuration</h2>
        <button type="button" className="ui-subtle-button" disabled={loading || permissions.busy !== null}
          onClick={() => setRevision((current) => current + 1)} aria-label="Refresh MCP sessions"><RefreshCw size={14} aria-hidden="true" /></button>
      </div>
      <p className="text-xs text-neutral-500">These settings affect only this Work/session. Initial values are copied from Settings; later changes to defaults do not rewrite saved configurations.</p>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {loading && <p role="status" className="text-xs text-neutral-500">Loading sessions...</p>}
      {!loading && !error && !workSessions.length && <p role="status" className="text-xs text-neutral-500">No CaseIQ web sessions for this Work yet. Start a CaseIQ Run to create its Session. Initial defaults are configured in Settings.</p>}
      {workSessions.length > 0 && <label className="block space-y-1 text-xs text-neutral-400">
        <span>Session in this Work</span>
        <select aria-label="MCP Session in this Work" value={selected?.sessionId ?? ""}
          disabled={loading || permissions.busy !== null} className="ui-input w-full max-w-full px-2 py-2 font-mono text-xs"
          onChange={(event) => setSelection({ scope, sessionId: event.target.value })}>
          <option value="" disabled>Select a Session</option>
          {workSessions.map((session) => <option key={session.sessionId} value={session.sessionId}>
            {session.sessionId}{!session.ready ? " · Not ready" : ""}
          </option>)}
        </select>
      </label>}
      {selected ? <>
        {selected.ready ? <CaseIqToolPermissionsPanel permissions={permissions} expanded />
          : <p role="status" className="text-sm text-amber-300">{selected.reason}</p>}
      </> : !loading && !error && workSessions.length > 0 && <p role="status" className="text-sm text-neutral-500">
        The requested Session is unavailable for this Work. Choose a Session from this Work above.
      </p>}
      <Link href="/settings#mcp-defaults" className="ui-subtle-button">MCP defaults in Settings</Link>
  </section>;
}
