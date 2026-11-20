"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, RefreshCw, Terminal } from "lucide-react";
import { z } from "zod";
import { CASEIQ_AUTHENTICATION_COMMAND, caseIqAuthenticationStatusSchema, type CaseIqAuthenticationStatus } from "@/lib/caseiq-options";
import { copyCodeText } from "@/components/CopyableCodeBlock";
import CaseIqAccessBanner from "@/components/CaseIqAccessBanner";
import CaseIqSignInProgress from "@/components/CaseIqSignInProgress";

export function useCaseIqAuthentication(workId: string, runId: string | null, enabled: boolean, automaticEnabled = false) {
  const router = useRouter();
  const [status, setStatus] = useState<CaseIqAuthenticationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [trustWorkFolder, setTrustWorkFolder] = useState(true);
  const [commandCopied, setCommandCopied] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const openingRef = useRef(false);
  const checkingRef = useRef(false);
  const requestVersion = useRef(0);
  const request = useRef<{ runId: string; requestId: string; trustWorkFolder: boolean; automatic?: boolean } | null>(null);
  const automaticAttempts = useRef(new Set<string>());
  const trustPreference = useRef<{ workId: string; value: boolean } | null>(null);
  const lastReserved = useRef(false);
  const scope = useRef(`${workId}:${runId}`);
  const endpoint = `/api/works/${encodeURIComponent(workId)}/caseiq/auth`;

  const apply = useCallback((value: CaseIqAuthenticationStatus) => {
    setStatus(value);
    if (value.operation?.reserved && value.operation.trustWorkFolder !== undefined &&
        (!value.sessionId || value.operation.sessionId === value.sessionId)) {
      setTrustWorkFolder(value.operation.trustWorkFolder);
    }
    if (request.current && value.operation?.id === request.current.requestId) {
      setUncertain(false);
      if (!value.operation.reserved) request.current = null;
    }
    if (lastReserved.current && !value.operation?.reserved) router.refresh();
    lastReserved.current = value.operation?.reserved ?? false;
  }, [router]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !runId || openingRef.current) return false;
    const currentScope = `${workId}:${runId}`;
    const version = ++requestVersion.current;
    try {
      const response = await fetch(`${endpoint}?runId=${encodeURIComponent(runId)}`, { cache: "no-store", signal });
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(body);
        throw new Error(failure.success ? failure.data.error : "The CaseIQ authentication state could not be checked.");
      }
      const parsed = caseIqAuthenticationStatusSchema.safeParse(body);
      if (!parsed.success) throw new Error("CaseIQ returned an invalid authentication state.");
      if (signal?.aborted || scope.current !== currentScope || requestVersion.current !== version) return false;
      apply(parsed.data); setError(null);
      return true;
    } catch (reason) {
      if (!signal?.aborted && scope.current === currentScope && requestVersion.current === version) throw reason;
      return false;
    }
  }, [apply, enabled, endpoint, runId, workId]);

  useEffect(() => {
    const controller = new AbortController();
    scope.current = `${workId}:${runId}`;
    requestVersion.current++;
    checkingRef.current = false; openingRef.current = false;
    request.current = null;
    automaticAttempts.current.clear();
    lastReserved.current = false;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setStatus(null); setError(null); setUncertain(false);
      setCheckedAt(null); setChecking(false); setOpening(false);
      setCommandCopied(false); setClipboardError(null);
      if (trustPreference.current?.workId !== workId) trustPreference.current = null;
      setTrustWorkFolder(trustPreference.current?.value ?? true);
      await refresh(controller.signal);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Authentication state could not be checked.");
    });
    const invalidateRequests = () => { requestVersion.current++; };
    return () => { controller.abort(); invalidateRequests(); };
  }, [refresh, runId, workId]);

  useEffect(() => {
    if (!enabled || !runId) return;
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || checkingRef.current || openingRef.current || document.hidden || controller.signal.aborted) return;
      checking = true;
      try { await refresh(controller.signal); }
      catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Authentication state could not be checked.");
      } finally { checking = false; }
    };
    const timer = setInterval(() => void check(), 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check);
    };
  }, [enabled, refresh, runId]);

  const copyCommand = useCallback(async () => {
    const currentScope = `${workId}:${runId}`;
    try {
      await copyCodeText(CASEIQ_AUTHENTICATION_COMMAND, navigator.clipboard);
      if (scope.current === currentScope) { setCommandCopied(true); setClipboardError(null); }
    } catch (reason) {
      if (scope.current === currentScope) {
        setCommandCopied(false);
        setClipboardError(reason instanceof Error ? reason.message : "The authentication command could not be copied.");
      }
    }
  }, [runId, workId]);

  const start = useCallback(async (automatic = false) => {
    if (!enabled || !runId || openingRef.current || checkingRef.current || uncertain || status?.operation?.reserved) {
      throw new Error("Wait for the current authentication request to be confirmed before opening another window.");
    }
    if (error) throw new Error("Refresh the CaseIQ authentication state before opening another window.");
    if (!status?.available) throw new Error(status?.blockedReason ?? "Check the CaseIQ authentication state before signing in.");
    if (automatic && (!status.automaticSignIn || status.automaticSignIn.attempted)) {
      throw new Error("No unhandled native SupportIQ sign-in requirement is available.");
    }
    const currentScope = `${workId}:${runId}`;
    if (scope.current !== currentScope) throw new Error("Wait for this Run's authentication state to finish loading.");
    const version = ++requestVersion.current;
    openingRef.current = true; setOpening(true); setError(null);
    request.current ??= {
      runId, requestId: automatic && status.automaticSignIn ? status.automaticSignIn.requestId : crypto.randomUUID(),
      trustWorkFolder, ...(automatic ? { automatic: true } : {}),
    };
    const pendingRequest = request.current;
    let dispatched = false;
    try {
      await copyCommand();
      if (scope.current !== currentScope || requestVersion.current !== version) {
        throw new Error("The selected CaseIQ Run changed before authentication was requested.");
      }
      dispatched = true;
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pendingRequest),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = z.object({ error: z.string() }).safeParse(body);
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          dispatched = false; request.current = null;
        }
        throw new Error(failure.success ? failure.data.error : "The authentication window request failed.");
      }
      const parsed = caseIqAuthenticationStatusSchema.safeParse(body);
      if (!parsed.success || parsed.data.operation?.id !== pendingRequest.requestId) {
        throw new Error("Authentication window acceptance is unconfirmed. It may already be open.");
      }
      if (scope.current === currentScope && requestVersion.current === version) apply(parsed.data);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Authentication window acceptance is unconfirmed.";
      if (scope.current === currentScope && requestVersion.current === version) { setError(message); setUncertain(dispatched); }
      throw new Error(message);
    } finally {
      if (scope.current === currentScope && requestVersion.current === version) { openingRef.current = false; setOpening(false); }
    }
  }, [enabled, runId, uncertain, status, error, workId, trustWorkFolder, copyCommand, endpoint, apply]);

  const reportError = useCallback((reason: unknown) => {
    if (scope.current === `${workId}:${runId}`) setError(reason instanceof Error ? reason.message : "The authentication action failed.");
  }, [runId, workId]);

  useEffect(() => {
    const requirement = status?.automaticSignIn;
    if (!requirement || requirement.attempted || !automaticEnabled || !enabled || !runId) return;
    if (!status.available && !status.operation?.reserved) {
      automaticAttempts.current.delete(requirement.requestId);
      return;
    }
    if (!status.available || status.authenticationVerified || status.operation?.reserved || openingRef.current ||
        checkingRef.current || opening || uncertain || error || document.hidden ||
        automaticAttempts.current.has(requirement.requestId)) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled || document.hidden || openingRef.current) return;
      automaticAttempts.current.add(requirement.requestId);
      try { await start(true); } catch (reason) { reportError(reason); }
    });
    return () => { cancelled = true; };
  }, [status, automaticEnabled, enabled, runId, opening, uncertain, error, start, reportError]);
  async function refreshManually() {
    if (checkingRef.current || openingRef.current) return;
    const currentScope = `${workId}:${runId}`;
    checkingRef.current = true; setChecking(true);
    try {
      if (await refresh()) setCheckedAt(new Date().toISOString());
    } catch (reason) { if (scope.current === currentScope) reportError(reason); }
    finally {
      if (scope.current === currentScope) { checkingRef.current = false; setChecking(false); }
    }
  }
  return {
    status, error, opening, uncertain, checking, checkedAt, trustWorkFolder,
    setTrustWorkFolder: (value: boolean) => { trustPreference.current = { workId, value }; setTrustWorkFolder(value); },
    commandCopied, clipboardError, copyCommand,
    reserved: opening || uncertain || Boolean(status?.operation?.reserved), refresh, refreshManually, start, reportError,
  };
}

export function CaseIqAuthenticationPanel({ authentication }: {
  authentication: ReturnType<typeof useCaseIqAuthentication>;
}) {
  const { status, error, opening, uncertain } = authentication;
  const connected = Boolean(status?.authenticationVerified && status?.connection?.status === "connected");
  const pendingAutomatic = Boolean(status?.automaticSignIn && !status.automaticSignIn.attempted);
  const failure = error ?? (status?.operation && ["failed", "unconfirmed"].includes(status.operation.status) &&
    !pendingAutomatic ? status.operation.message : null);
  const summary = opening ? "Opening window" : authentication.checking || !status ? "Checking..."
    : status.operation?.reserved ? connected ? "OAuth checked · Close Terminal"
      : status.operation.phase === "native-started" ? "Waiting for TSE sign-in" : "Preparing Session"
      : connected ? `OAuth checked · ${status.connection?.toolCount} tools`
        : status.connection?.status === "needs-auth"
          ? status.automaticSignIn && !status.automaticSignIn.attempted && !status.available
            ? "Sign-in queued" : "Sign-in required"
          : "Not verified";
  const revealKey = opening || status?.operation?.reserved ? "signing-in"
      : status?.automaticSignIn && !status.automaticSignIn.attempted ? status.automaticSignIn.requestId : null;
  return <CaseIqAccessBanner label="SupportIQ sign-in" summary={summary} verified={connected}
    busy={opening || authentication.checking || !status && !error} error={failure} revealKey={revealKey}>
    <CaseIqSignInProgress status={status} opening={opening} uncertain={uncertain} error={failure}
      commandCopied={authentication.commandCopied} clipboardError={authentication.clipboardError} />
    {connected && <p className="mb-2 text-neutral-400">{status?.connection?.toolCount} tools discovered · OAuth checked at {status?.connection?.checkedAt &&
      <time dateTime={status.connection.checkedAt}>{new Date(status.connection.checkedAt).toLocaleString()}</time>}</p>}
    {connected && <p role="status" className="mb-2 text-neutral-400">{status?.operation?.reserved
      ? "SupportIQ was verified. Exit Copilot to release this Work for Follow Up."
      : "The authentication window is closed. This is its last verified state, not an active MCP connection."}</p>}
    {connected && <p className="mb-2 text-neutral-400">Native connectivity and OAuth token presence were checked. This does not verify case access or guarantee a future Run.</p>}
    {status?.connection?.status === "needs-auth" && <p role="alert" className="mb-2 text-amber-300">
      SupportIQ requires authentication. A previous connection or visible tool list is not proof of a usable OAuth sign-in.
    </p>}
    {!connected && status?.connection?.status === "unknown" && <p role="status" className="mb-2 text-neutral-400">
      OAuth sign-in has not been verified. Connection history, tool discovery and closing the window alone are insufficient.
    </p>}
    {status?.oauthStorage?.mode === "shared" && <p role="status" className="mb-2 text-neutral-400">
      Shared OAuth cache prepared for your CaseIQ Works and Sessions on this host with the same SupportIQ configuration.
      Sign in once for this profile; expired or revoked credentials may require sign-in again. Changing the TSE account affects other Sessions in this profile.
      Other CaseIQ MCP OAuth sign-ins also use this cache. History and tool approvals remain separate; this is not sign-in verification.
    </p>}
    {status?.oauthStorage?.mode === "session" && <p role="alert" className="mb-2 text-amber-300">
      Shared OAuth is unavailable ({status.oauthStorage.reason}). The original cache is preserved; sign in for this Session.
    </p>}
    {status?.oauthStorage && <p className="mb-2 text-neutral-400">Existing private caches are not imported. The shared profile may need one initial TSE sign-in.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="ui-subtle-button" disabled={!status?.available || authentication.reserved || authentication.checking || Boolean(error)}
        onClick={() => { void authentication.start().catch(authentication.reportError); }}>
        <Terminal size={13} aria-hidden="true" />{opening ? "Opening authentication window..." : "Sign in to SupportIQ"}
      </button>
      <button type="button" className="ui-subtle-button" onClick={() => { void authentication.copyCommand(); }}>
        <Copy size={13} aria-hidden="true" />{authentication.commandCopied ? "Command copied" : "Copy authentication command"}
      </button>
      <button type="button" className="ui-subtle-button" disabled={authentication.checking}
        onClick={() => { void authentication.refreshManually(); }}>
        <RefreshCw size={13} className={authentication.checking ? "animate-spin" : undefined} aria-hidden="true" />
        {authentication.checking ? "Checking sign-in state..." : "Refresh sign-in state"}
      </button>
      <Link href="/docs/caseiq#supportiq-认证与临时终端" className="text-neutral-400 underline">Sign-in help</Link>
    </div>
    {!status && !error && <p role="status" className="mt-1 text-neutral-400">Checking SupportIQ sign-in state...</p>}
    <p className="mt-1 text-neutral-400">Use this action, not a request to the model. It opens the original CaseIQ session without sending a task Prompt.</p>
    <label className="mt-1 flex items-start gap-2 text-neutral-400">
      <input type="checkbox" aria-label="Trust this Work's exact folder" checked={authentication.trustWorkFolder} disabled={authentication.reserved}
        onChange={(event) => authentication.setTrustWorkFolder(event.target.checked)} />
      <span>Trust this Work&apos;s exact folder in its private CaseIQ session before opening. No parent/global folder trust or Full access is granted.</span>
    </label>
    <p className="mt-1 text-neutral-400">On this visible Work Conversation, a confirmed native SupportIQ sign-in requirement opens its Terminal automatically once the Work is idle. Unknown state alone does not open a window.</p>
    {authentication.commandCopied && <p role="status" className="mt-1 text-neutral-400">The authentication command is on the clipboard; paste it in the native window.</p>}
    {authentication.clipboardError && <p role="alert" className="mt-1 text-red-400">{authentication.clipboardError} You can type {CASEIQ_AUTHENTICATION_COMMAND} manually.</p>}
    <p className="mt-1 text-neutral-400">In the window, run <code>/mcp auth SupportIQ</code>, select your TSE account, then exit Copilot and return here. No automatic window closing or Full access upgrade is granted.</p>
    {status?.operation && !connected && <p role="status" className="mt-1 text-amber-200">{status.operation.message}</p>}
    {status?.blockedReason && !status.operation?.reserved && <p role="status" className="mt-1 text-neutral-400">{status.blockedReason}</p>}
    {uncertain && <p role="status" className="mt-1 text-amber-200">The window may already be open. Refresh its state; do not submit another authentication request.</p>}
    {failure && <p role="alert" className="mt-1 text-red-400">{failure}</p>}
    {authentication.checkedAt && !error && <p role="status" className="mt-1 text-neutral-400">Sign-in state checked at <time dateTime={authentication.checkedAt}>{new Date(authentication.checkedAt).toLocaleString()}</time>. {connected ? "Native MCP connection and tools were verified." : "Native MCP connection is not verified; window exit alone is not authorization."}</p>}
  </CaseIqAccessBanner>;
}

export function CaseIqSignInCallout({ authentication }: {
  authentication: ReturnType<typeof useCaseIqAuthentication>;
}) {
  const connected = authentication.status?.authenticationVerified && authentication.status.connection?.status === "connected";
  const otherWindowOpen = authentication.status?.sessionId && authentication.status.operation?.reserved &&
    authentication.status.operation.sessionId !== authentication.status.sessionId;
  return <CaseIqSignInProgress compact status={authentication.status} opening={authentication.opening}
    uncertain={authentication.uncertain} error={authentication.error}
    commandCopied={authentication.commandCopied} clipboardError={authentication.clipboardError}
    actions={<>
      {!authentication.reserved && !connected && authentication.status?.available && <label className="flex items-start gap-2">
        <input type="checkbox" aria-label="Trust this Work's exact folder" checked={authentication.trustWorkFolder}
          onChange={(event) => authentication.setTrustWorkFolder(event.target.checked)} />
        <span>Trust exact Work folder; no Full access.</span>
      </label>}
      <div className="flex flex-wrap items-center gap-2">
        {!authentication.reserved && !connected && <button type="button" className="ui-primary-button"
          disabled={!authentication.status?.available || authentication.checking || Boolean(authentication.error)}
          onClick={() => { void authentication.start().catch(authentication.reportError); }}>
          <Terminal size={13} aria-hidden="true" />Sign in to SupportIQ
        </button>}
        {!connected && !otherWindowOpen && <button type="button" className="ui-subtle-button" aria-label="Copy authentication command"
          onClick={() => { void authentication.copyCommand(); }}>
          <Copy size={13} aria-hidden="true" />{authentication.commandCopied ? "Command copied" : "Copy command"}
        </button>}
        <button type="button" className="ui-subtle-button" disabled={authentication.checking} aria-label="Refresh sign-in state"
          onClick={() => { void authentication.refreshManually(); }}>
          <RefreshCw size={13} className={authentication.checking ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden="true" />
          {authentication.checking ? "Checking..." : "Refresh"}
        </button>
      </div>
    </>} />;
}
