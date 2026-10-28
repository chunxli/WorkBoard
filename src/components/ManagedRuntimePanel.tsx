"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ElicitationFieldValue, ElicitationSchemaField } from "@github/copilot-sdk";
import type { ManagedRuntimeState, RuntimeInteraction, RuntimeMcpServer, RuntimeReply } from "@/lib/managed-runtime-types";

const inputClass = "w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100";

function FormField({ field, id, required, value, onChange }: {
  field: ElicitationSchemaField; id: string; required: boolean;
  value: ElicitationFieldValue | undefined; onChange: (value: ElicitationFieldValue | undefined) => void;
}) {
  if (field.type === "boolean") {
    return <input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
  }
  if (field.type === "array") {
    const choices = "enum" in field.items ? field.items.enum.map((item) => ({ const: item, title: item })) : field.items.anyOf;
    return <select id={id} multiple className={inputClass} required={required}
      value={Array.isArray(value) ? value : []}
      onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}>
      {choices.map((item) => <option key={item.const} value={item.const}>{item.title}</option>)}
    </select>;
  }
  if (field.type === "number" || field.type === "integer") {
    return <input id={id} className={inputClass} type="number" step={field.type === "integer" ? 1 : "any"}
      required={required} min={field.minimum} max={field.maximum} value={typeof value === "number" ? value : ""}
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.valueAsNumber)} />;
  }
  if (field.type === "string") {
    if ("enum" in field || "oneOf" in field) {
      const choices = "enum" in field ? field.enum.map((item, index) => ({ const: item, title: field.enumNames?.[index] ?? item })) : field.oneOf;
      return <select id={id} className={inputClass} required={required} value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}>
        <option value="">Select...</option>
        {choices.map((item) => <option key={item.const} value={item.const}>{item.title}</option>)}
      </select>;
    }
    return <input id={id} className={inputClass} required={required} minLength={field.minLength} maxLength={field.maxLength}
      type={field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
      placeholder={field.format === "date-time" ? "2026-01-01T12:00:00Z" : undefined}
      value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
  }
}

export function RuntimeInteractionCard({ request, busy, onReply }: {
  request: RuntimeInteraction; busy: boolean; onReply: (reply: RuntimeReply) => Promise<void>;
}) {
  const prefix = useId();
  const [answer, setAnswer] = useState("");
  const [content, setContent] = useState<Record<string, ElicitationFieldValue>>(() =>
    request.kind === "form" ? Object.fromEntries(Object.entries(request.schema.properties).flatMap(([key, field]) =>
      field.default !== undefined ? [[key, field.default]] : field.type === "boolean" && request.schema.required?.includes(key) ? [[key, false]] : [])) : {});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (request.kind === "question") void onReply({ kind: "question", requestId: request.id, answer });
    if (request.kind === "form") void onReply({ kind: "elicitation", requestId: request.id, action: "accept", content });
  };
  return <section className="space-y-2 rounded-md border border-amber-700/60 bg-amber-950/15 p-3" aria-label="Copilot needs your response">
    {request.kind === "permission" ? <>
      <h3 className="font-semibold text-amber-200">{request.title}</h3>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{request.detail}</pre>
      {request.managed && <p className="text-xs text-amber-200">Organization-managed approval: an explicit user decision is required.</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} className="ui-primary-button" onClick={() => void onReply({ kind: "permission", requestId: request.id, approved: true })}>Allow once</button>
        <button type="button" disabled={busy} className="ui-secondary-button" onClick={() => void onReply({ kind: "permission", requestId: request.id, approved: false })}>Deny</button>
      </div>
    </> : request.kind === "url" ? <>
      <p className="whitespace-pre-wrap">{request.message}</p>
      <a href={request.url} target="_blank" rel="noopener noreferrer" className="text-emerald-400 underline">Open requested page</a>
      <p className="text-xs text-neutral-400">Complete the browser flow before confirming. Work Board does not collect credentials.</p>
      <button type="button" disabled={busy} className="ui-primary-button" onClick={() => void onReply({ kind: "elicitation", requestId: request.id, action: "accept" })}>I completed this step</button>
      <button type="button" disabled={busy} className="ui-secondary-button" onClick={() => void onReply({ kind: "elicitation", requestId: request.id, action: "cancel" })}>Cancel</button>
    </> : <form onSubmit={submit} className="space-y-2">
      <p className="whitespace-pre-wrap font-semibold">{request.kind === "question" ? request.question : request.message}</p>
      <fieldset disabled={busy} className="space-y-2">
        {request.kind === "question" ? <>
          {request.choices.map((choice, index) => <label key={index} className="flex items-start gap-2">
            <input type="radio" name={prefix} value={choice} checked={answer === choice} onChange={() => setAnswer(choice)} />{choice}
          </label>)}
          {request.allowFreeform && <label className="block space-y-1"><span>Your answer</span>
            <textarea className={inputClass} value={request.choices.includes(answer) ? "" : answer} onChange={(event) => setAnswer(event.target.value)} maxLength={100_000} />
          </label>}
        </> : Object.entries(request.schema.properties).map(([name, field]) => <div key={name} className="space-y-1">
          <label htmlFor={`${prefix}-${name}`} className="block">{field.title ?? name}{request.schema.required?.includes(name) ? " *" : ""}</label>
          {field.description && <p className="text-xs text-neutral-400">{field.description}</p>}
          <FormField id={`${prefix}-${name}`} field={field} required={request.schema.required?.includes(name) ?? false} value={content[name]}
            onChange={(value) => setContent((current) => {
              const next = { ...current };
              if (value === undefined) { delete next[name]; return next; }
              return { ...next, [name]: value };
            })} />
        </div>)}
        <button type="submit" className="ui-primary-button" disabled={request.kind === "question" && !answer.trim()}>Send response</button>
        {request.kind === "form" && <>
          <button type="button" className="ui-secondary-button" onClick={() => void onReply({ kind: "elicitation", requestId: request.id, action: "decline" })}>Decline</button>
          <button type="button" className="ui-secondary-button" onClick={() => void onReply({ kind: "elicitation", requestId: request.id, action: "cancel" })}>Cancel</button>
        </>}
      </fieldset>
    </form>}
  </section>;
}

interface ApiResponse {
  error?: string; available?: boolean; reason?: string; state?: ManagedRuntimeState;
  authorizationUrl?: string | null; tools?: string[];
}

export function RuntimeMcpServerRow({ server, busy, onAction }: {
  server: RuntimeMcpServer; busy: boolean;
  onAction: (action: "mcp-login" | "mcp-tools", serverName: string) => Promise<void>;
}) {
  return <li className="flex flex-wrap items-center gap-2">
    <span className="min-w-0 break-all font-mono">{server.name}</span><span>{server.status}</span>
    {server.status === "connected" && <button type="button" disabled={busy} className="ui-secondary-button" onClick={() => void onAction("mcp-tools", server.name)}>Verify tools</button>}
    {server.authentication === "oauth" && server.status === "needs-auth" && <button type="button" disabled={busy} className="ui-secondary-button" onClick={() => void onAction("mcp-login", server.name)}>Sign in</button>}
    {server.authentication === "copilot-account" && <span className="text-neutral-400">Uses Copilot account; no separate MCP sign-in.</span>}
    {server.authentication === "native" && <span className="text-neutral-400">Uses native Copilot authentication.</span>}
    {(server.authentication === "terminal" || server.authentication === "entra-host-required") && <details className="w-full rounded-md border border-amber-800/60 bg-amber-950/15 p-2 text-amber-300">
      <summary className="cursor-pointer font-semibold">Authenticate in Terminal</summary>
      <div className="mt-2 space-y-1">
        <p>Terminal authentication required</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>In a local Terminal, open this Work&apos;s directory and run <code>copilot</code>.</li>
          <li>Use <code>/mcp</code>, select <span className="break-all font-mono">{server.name}</span> and sign in with your company account. Confirm the connection in Terminal.</li>
          <li>Return here and select <strong>Reload native MCP</strong>. If connected, use <strong>Verify tools</strong>.</li>
        </ol>
        <p>Terminal credentials may not be reusable here. If it still needs authentication, use this MCP in Terminal; App access has not been confirmed.</p>
        <p>No App registration, Client ID, client secret or token input is needed for this fallback. You do not need to replay or resume your task just to authenticate.</p>
      </div>
    </details>}
  </li>;
}

export default function ManagedRuntimePanel({ workId, runId }: { workId: string; runId: string }) {
  const [state, setState] = useState<ManagedRuntimeState | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replyBusy, setReplyBusy] = useState(false);
  const pendingActions = useRef({ reply: false, mcp: false });
  const [refresh, setRefresh] = useState(0);
  const [login, setLogin] = useState<{ server: string; url: string } | null>(null);
  const [tools, setTools] = useState<{ server: string; names: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endpoint = `/api/works/${encodeURIComponent(workId)}/runtime`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const load = async () => {
      if (loading || document.hidden || controller.signal.aborted) return;
      loading = true;
      try {
        const response = await fetch(`${endpoint}?runId=${encodeURIComponent(runId)}`, { cache: "no-store", signal: controller.signal });
        const body: ApiResponse = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not read runtime state.");
        if (typeof body.available !== "boolean" || body.available && !body.state) throw new Error("Invalid runtime state response.");
        if (controller.signal.aborted) return;
        setState(body.state ?? null);
        setReason(body.available ? null : body.reason ?? "Live runtime controls are unavailable.");
        setReadError(null);
        setLogin((current) => current && body.state?.mcp.find((server) => server.name === current.server)?.status !== "connected" ? current : null);
      } catch (failure) {
        if (!controller.signal.aborted) setReadError(failure instanceof Error ? failure.message : "Could not read runtime state.");
      } finally {
        loading = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 2000);
      }
    };
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void load(); } };
    void load();
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [endpoint, runId, refresh]);

  const act = async (action: "reply" | "mcp-login" | "mcp-tools" | "mcp-reload", extra: { reply?: RuntimeReply; serverName?: string } = {}) => {
    const group = action === "reply" ? "reply" : "mcp";
    if (!state || pendingActions.current[group]) return;
    pendingActions.current[group] = true;
    const setPending = group === "reply" ? setReplyBusy : setBusy;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, sessionId: state.sessionId, action, ...extra }),
      });
      const body: ApiResponse = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Runtime action failed.");
      if (action === "reply" && extra.reply) setState((current) => current ? { ...current, requests: current.requests.filter((item) => item.id !== extra.reply?.requestId) } : null);
      if (action === "mcp-login") {
        setLogin(body.authorizationUrl ? { server: extra.serverName!, url: body.authorizationUrl } : null);
        setNotice(body.authorizationUrl ? "Open the sign-in link below. Completion is confirmed by the live MCP connection status." : "Copilot completed the sign-in request using its local authentication flow. Check the live connection status.");
      }
      if (action === "mcp-tools") {
        if (!Array.isArray(body.tools) || !body.tools.every((name) => typeof name === "string")) throw new Error("Copilot returned an invalid tools/list response.");
        setTools({ server: extra.serverName!, names: body.tools });
      }
      if (action === "mcp-reload") setNotice("Copilot reloaded this session's native MCP configuration. Check each server's connection status.");
      setRefresh((value) => value + 1);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Runtime action failed. Refresh before retrying.";
      setError(extra.serverName ? `${extra.serverName}: ${message}` : message);
    } finally { pendingActions.current[group] = false; setPending(false); }
  };

  return <aside aria-label="Live Copilot controls" className="max-h-[45dvh] shrink-0 space-y-2 overflow-auto text-sm text-neutral-200">
    {state?.requests.map((request) => <RuntimeInteractionCard key={request.id} request={request} busy={replyBusy} onReply={(reply) => act("reply", { reply })} />)}
    {(error || readError) && <p role="alert" className="text-xs text-red-400">{error ?? readError} <button type="button" className="underline" onClick={() => { setError(null); setRefresh((value) => value + 1); }}>Refresh runtime</button></p>}
    <details className="rounded-md border border-neutral-800 px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold">Copilot runtime &amp; MCP{state?.requests.length ? ` - ${state.requests.length} awaiting response` : ""}</summary>
      <div className="mt-2 space-y-2 text-xs">
        <p className="text-neutral-400">Uses this Work&apos;s native local Copilot configuration and credential cache. No other repository&apos;s MCP configuration is imported. Native Terminal-only features such as computer-use and MCP Apps are not enabled here; use Open / Resume in Terminal for those.</p>
        <p className="text-neutral-400">When Terminal authentication is required, use <code>copilot</code> and <code>/mcp</code> in a local Terminal. Expand Authenticate in Terminal beside the server for steps. No App registration is needed for that fallback. Reload native MCP here afterward; only a connected status and Verify tools confirm App access.</p>
        {reason && <p>{reason}</p>}
        {!state && !reason && !error && <p>Connecting to the live runtime...</p>}
        {state && <>
          {!state.ready && <p>Copilot is starting. Pending approvals can still be answered above.</p>}
          {state.mcpError && <p role="alert" className="text-red-400">{state.mcpError}</p>}
          {state.thirdPartyEnabled === false && <p className="text-amber-300">Third-party MCP is disabled by the runtime or policy.</p>}
          {state.ready && !state.mcpError && state.mcp.length === 0 && <p>No MCP servers are registered in this live session yet. This does not inspect other repositories.</p>}
          <ul className="space-y-2">{state.mcp.map((server) => <RuntimeMcpServerRow key={server.name} server={server} busy={busy}
            onAction={(action, serverName) => act(action, { serverName })} />)}</ul>
          <button type="button" disabled={busy || !state.ready} className="ui-secondary-button" onClick={() => void act("mcp-reload")}>Reload native MCP</button>
        </>}
        {notice && <p role="status">{notice}</p>}
        {login && <a href={login.url} target="_blank" rel="noopener noreferrer" className="block text-emerald-400 underline">Open native sign-in for {login.server}</a>}
        {tools && <p role="status" className="break-words">{tools.server}: {tools.names.length} tools{tools.names.length ? ` - ${tools.names.join(", ")}` : ""}</p>}
      </div>
    </details>
  </aside>;
}
