"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { z } from "zod";
import { caseIqMcpConfigurationHref, caseIqMcpPermissionStatusSchema, type CaseIqMcpPermissionDecision, type CaseIqMcpPermissionStatus } from "@/lib/caseiq-options";
import CaseIqAccessBanner from "@/components/CaseIqAccessBanner";

export function useCaseIqToolPermissions(workId: string, runId: string | null, enabled: boolean) {
  const [status, setStatus] = useState<CaseIqMcpPermissionStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const busyRef = useRef(false);
  const checkingRef = useRef(false);
  const requestVersion = useRef(0);
  const scope = useRef(`${workId}:${runId}`);
  const endpoint = `/api/works/${encodeURIComponent(workId)}/caseiq/mcp-permissions`;
  const error = decisionError ?? readError;

  const readResponse = useCallback(async (response: Response) => {
    const body: unknown = await response.json();
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(body);
      throw new Error(failure.success ? failure.data.error : "MCP tool approvals could not be checked or saved.");
    }
    const parsed = caseIqMcpPermissionStatusSchema.safeParse(body);
    if (!parsed.success) throw new Error("CaseIQ returned an invalid tool approval state. Refresh before deciding.");
    return parsed.data;
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !runId || busyRef.current) return false;
    const currentScope = `${workId}:${runId}`;
    const version = ++requestVersion.current;
    try {
      const response = await fetch(`${endpoint}?runId=${encodeURIComponent(runId)}`, { cache: "no-store", signal });
      const value = await readResponse(response);
      if (signal?.aborted || scope.current !== currentScope || requestVersion.current !== version) return false;
      setStatus(value); setReadError(null);
      return true;
    } catch (reason) {
      if (!signal?.aborted && scope.current === currentScope && requestVersion.current === version) throw reason;
      return false;
    }
  }, [enabled, endpoint, readResponse, runId, workId]);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = `${workId}:${runId}`;
    requestVersion.current++;
    busyRef.current = false; checkingRef.current = false;
    const report = (reason: unknown) => {
      if (!controller.signal.aborted) setReadError(reason instanceof Error ? reason.message : "Tool approvals could not be checked.");
    };
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setStatus(null); setReadError(null); setDecisionError(null); setNotice(null);
      setLoading(true); setChecking(false); setBusy(null); setCheckedAt(null);
      try { await refresh(controller.signal); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }).catch(report);
    let checking = false;
    const check = async () => {
      if (!enabled || !runId || checking || checkingRef.current || busyRef.current || document.hidden || controller.signal.aborted) return;
      checking = true;
      try { await refresh(controller.signal); } catch (reason) { report(reason); }
      finally { checking = false; }
    };
    const timer = setInterval(() => void check(), 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const invalidateRequests = () => { requestVersion.current++; };
    return () => {
      controller.abort(); invalidateRequests(); clearInterval(timer);
      window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check);
    };
  }, [enabled, refresh, runId, workId]);

  async function saveDecision(decision: CaseIqMcpPermissionDecision, pending: string, message: string) {
    if (!enabled || !runId || busyRef.current || checkingRef.current || loading || error || !status?.available) {
      setDecisionError(error ?? status?.blockedReason ?? "Wait for this session's tool approval state before deciding.");
      return;
    }
    const currentScope = `${workId}:${runId}`;
    if (scope.current !== currentScope) { setDecisionError("Refresh this Run's tool approvals before deciding."); return; }
    const version = ++requestVersion.current;
    busyRef.current = true;
    setBusy(pending); setReadError(null); setDecisionError(null); setNotice(null);
    try {
      const value = await readResponse(await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, ...decision }),
      }));
      if (scope.current === currentScope && requestVersion.current === version) {
        setStatus(value);
        setNotice(message);
      }
    } catch (reason) {
      if (scope.current === currentScope && requestVersion.current === version) {
        setDecisionError(`${reason instanceof Error ? reason.message : "Tool approval acceptance is unconfirmed."} Refresh tool approvals before retrying.`);
      }
    } finally {
      if (scope.current === currentScope && requestVersion.current === version) { busyRef.current = false; setBusy(null); }
    }
  }

  async function decide(serverName: string, name: string, approved: boolean) {
    await saveDecision({ serverName, toolName: name, approved }, JSON.stringify([serverName, name]), approved
      ? `${serverName}(${name}) is approved for future Runs in this Work/session. Send a new Follow Up when ready; the failed request was not replayed.`
      : `${serverName}(${name}) approval was removed for future Runs.`);
  }

  async function approveRequested(serverName: string) {
    const toolNames = status?.servers.find((server) => server.serverName === serverName)?.tools
      .filter((tool) => !tool.approved && !tool.managed).map((tool) => tool.name) ?? [];
    if (!toolNames.length) { setDecisionError("There are no pending tools to approve. Refresh tool approvals."); return; }
    await saveDecision({ serverName, action: "approve-requested", toolNames }, JSON.stringify([serverName, "$requested"]),
      `${toolNames.length} requested ${serverName} tools are approved for future Runs in this Work/session. New tools still need approval; the failed request was not replayed.`);
  }

  async function setAutomatic(serverName: string, automatic: boolean) {
    await saveDecision({ serverName, action: "set-automatic", enabled: automatic }, JSON.stringify([serverName, "$automatic"]), automatic
      ? `All ${serverName} tools, including future tools, are approved for future Runs in this Work/session. No other MCP was granted and no Prompt was replayed.`
      : `Automatic ${serverName} approval is off. Existing individual approvals are unchanged; no Prompt was replayed.`);
  }

  async function refreshManually() {
    if (checkingRef.current || busyRef.current) return;
    const currentScope = `${workId}:${runId}`;
    checkingRef.current = true; setChecking(true); setNotice(null);
    try {
      if (await refresh()) {
        setDecisionError(null); setCheckedAt(new Date().toISOString());
      }
    } catch (reason) {
      if (scope.current === currentScope) setReadError(reason instanceof Error ? reason.message : "Tool approvals could not be checked.");
    } finally {
      if (scope.current === currentScope) { checkingRef.current = false; setChecking(false); }
    }
  }
  const configurationHref = caseIqMcpConfigurationHref(workId, status?.sessionId);
  return { status, error, busy, notice, loading, checking, checkedAt, decide, approveRequested, setAutomatic, refreshManually, configurationHref };
}

export function CaseIqToolPermissionsPanel({ permissions, expanded = false, onOpenConfiguration }: {
  permissions: ReturnType<typeof useCaseIqToolPermissions>; expanded?: boolean; onOpenConfiguration?: () => void;
}) {
  const { status, error, busy, notice, loading, checking, checkedAt } = permissions;
  const pending = status?.servers.reduce((total, server) => total + (server.autoApprove ? 0
    : server.tools.filter((tool) => !tool.approved && !tool.managed).length), 0) ?? 0;
  const disabled = !status?.available || loading || checking || Boolean(error) || busy !== null;
  const automatic = status?.servers.filter((server) => server.autoApprove).length ?? 0;
  const serverCount = status?.servers.length ?? 0;
  const content = <>
    <div className="flex flex-wrap items-center gap-2">
      {pending > 0 && <span className="text-amber-300">{pending} awaiting approval</span>}
      <button type="button" className="ui-subtle-button" disabled={loading || checking || busy !== null} onClick={() => { void permissions.refreshManually(); }}>
        <RefreshCw size={13} className={checking ? "animate-spin" : undefined} aria-hidden="true" />{checking ? "Checking tool approvals..." : "Refresh tool approvals"}
      </button>
      <Link href="/docs/caseiq#登录成功但工具调用被拒绝" className="text-neutral-400 underline">Tool approval help</Link>
      {!expanded && (onOpenConfiguration
        ? <button type="button" onClick={onOpenConfiguration} className="ui-subtle-button">MCP configuration</button>
        : <Link href={permissions.configurationHref} className="ui-subtle-button">MCP configuration</Link>)}
    </div>
    <p className="mt-1 text-neutral-400">Sign-in is not tool approval. Initial defaults come from Settings; saved Work/session settings and original CaseIQ pre-approvals are retained. File/URL permissions and organization restrictions are unchanged; no arbitrary server can be added here.</p>
    {loading && !error && <p role="status" className="mt-1 text-neutral-400">Loading this session&apos;s tool approvals...</p>}
    {status?.servers.map((server) => {
      const { serverName, autoApprove: automatic } = server;
      const requested = automatic ? 0 : server.tools.filter((tool) => !tool.approved && !tool.managed).length;
      return <section key={serverName} aria-label={`${serverName} tool approvals`} className="mt-2 min-w-0 rounded border border-neutral-700 px-2 py-1.5">
        <details open={serverName === "SupportIQ" || requested > 0 || automatic}>
          <summary className="cursor-pointer break-all text-neutral-300">
            <strong>{serverName}</strong>
            <span className={automatic ? "ml-2 text-emerald-400" : "ml-2 text-neutral-400"}>
              {automatic ? "Automatic approval on" : requested ? `${requested} awaiting approval` : "Individual approvals"}
            </span>
          </summary>
          <div className="mt-2 space-y-1">
            {requested > 0 && <button type="button" className="ui-subtle-button"
              aria-label={`Allow all requested tools for ${serverName} (${requested})`} disabled={disabled}
              onClick={() => { void permissions.approveRequested(serverName); }}>
              {busy === JSON.stringify([serverName, "$requested"]) ? "Saving..." : `Allow all requested tools (${requested})`}
            </button>}
            <label className="flex items-start gap-2 text-neutral-400">
              <input type="checkbox" checked={automatic} disabled={disabled}
                className="accent-emerald-500" onChange={(event) => { void permissions.setAutomatic(serverName, event.target.checked); }} />
              <span>Automatically allow all {serverName} tools in this Work/session, including future tools</span>
            </label>
            <p className="text-neutral-400">Automatic approval also covers write-capable tools if this MCP exposes them. Turning it off keeps existing individual approvals. Changes apply only to future Runs and do not authorize any other MCP.</p>
            {busy === JSON.stringify([serverName, "$automatic"]) && <p role="status" className="text-neutral-400">Saving {serverName} automatic approval...</p>}
            {!server.tools.length && <p className="text-neutral-400">No {serverName} tool permission requests have been recorded in this session yet.</p>}
            {server.tools.map((tool) => <div key={tool.name} className="flex flex-wrap items-center gap-2 pt-1">
              <code className="min-w-0 break-all" title={`${serverName}(${tool.name})`}>{serverName}({tool.name})</code>
              <span className={(tool.approved || automatic) && !tool.managed ? "text-emerald-400" : "text-amber-300"}>{tool.managed
                ? tool.approved ? "Work rule approved; organization approval still required" : "Organization approval required"
                : automatic ? "Automatically approved for this Work/session" : tool.approved ? "Approved for this Work/session" : "Not approved"}</span>
              {!automatic && <button type="button" className="ui-subtle-button"
                aria-label={tool.approved ? `Revoke ${serverName}(${tool.name}) approval` : `Allow ${serverName}(${tool.name}) for this Work/session`}
                disabled={disabled || !tool.approved && tool.managed}
                onClick={() => { void permissions.decide(serverName, tool.name, !tool.approved); }}>
                {busy === JSON.stringify([serverName, tool.name]) ? "Saving..." : tool.approved ? "Revoke tool approval" : "Allow this tool"}
              </button>}
            </div>)}
          </div>
        </details>
      </section>;
    })}
    {status?.blockedReason && <p role="status" className="mt-1 text-neutral-400">{status.blockedReason}</p>}
    {notice && <p role="status" className="mt-1 text-emerald-400">{notice}</p>}
    {checkedAt && !error && <p role="status" className="mt-1 text-neutral-400">Tool approvals checked at <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time>. No task was started.</p>}
    {error && <p role="alert" className="mt-1 text-red-400">{error}</p>}
  </>;
  if (expanded) return <section aria-label="CaseIQ MCP tool approvals" aria-busy={loading || checking || busy !== null}
    className="min-w-0 [overflow-wrap:anywhere] text-xs">{content}</section>;
  return <CaseIqAccessBanner label="CaseIQ MCP tool approvals" title="MCP tool approvals"
    summary={loading ? "Loading..." : `${serverCount} MCP${serverCount === 1 ? "" : "s"} · ${automatic} automatic${pending ? ` · ${pending} pending` : ""}`}
    busy={loading || checking || busy !== null} error={error}>{content}</CaseIqAccessBanner>;
}
