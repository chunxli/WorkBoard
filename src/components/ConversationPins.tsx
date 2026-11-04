"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, Pin, PinOff, RefreshCw, X } from "lucide-react";
import { z } from "zod";
import { conversationPinSchema, type ConversationPin } from "@/lib/conversation-pin-types";

const listSchema = z.object({ sessionId: z.string(), pins: z.array(conversationPinSchema) });
export const ConversationPinsContext = createContext<{
  pins: ConversationPin[]; loading: boolean; busy: boolean; activePin: ConversationPin | null;
  error: string | null; notice: string | null;
  toggle(eventId: string, line: number): void;
  navigate(pin: ConversationPin): void;
  remove(pin: ConversationPin): void;
  refresh(): void;
} | null>(null);

export function ConversationPinsProvider({ workId, runId, sessionId, activePin, onActivePinChange, onNavigate, children }: {
  workId: string; runId: string | null; sessionId: string | null;
  activePin: ConversationPin | null; onActivePinChange(pin: ConversationPin | null): void;
  onNavigate(pin: ConversationPin): Promise<void>; children: ReactNode;
}) {
  const [storedPins, setStoredPins] = useState<{ sessionId: string | null; pins: ConversationPin[] }>({ sessionId: null, pins: [] });
  const pins = useMemo(() => storedPins.sessionId === sessionId ? storedPins.pins : [], [storedPins, sessionId]);
  const currentSession = useRef(sessionId);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusSession, setStatusSession] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  const endpoint = `/api/works/${encodeURIComponent(workId)}/conversation/pins`;
  const requestKey = `${endpoint}:${runId}:${sessionId}:${version}`;
  const loading = Boolean(sessionId && loadedFor !== requestKey);

  useLayoutEffect(() => { currentSession.current = sessionId; }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!runId || !sessionId) return;
    const controller = new AbortController();
    void fetch(`${endpoint}?${new URLSearchParams({ runId })}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to load Pins.");
        const parsed = listSchema.safeParse(body);
        if (!parsed.success || parsed.data.sessionId !== sessionId) throw new Error("The Pin list does not match this Session.");
        if (!controller.signal.aborted && currentSession.current === sessionId) {
          setStoredPins({ sessionId, pins: parsed.data.pins }); setError(null); setStatusSession(sessionId);
        }
      }).catch((reason) => {
        if (!controller.signal.aborted && currentSession.current === sessionId) {
          setError(reason instanceof Error ? reason.message : "Unable to load Pins."); setStatusSession(sessionId);
        }
      }).finally(() => { if (!controller.signal.aborted) setLoadedFor(requestKey); });
    return () => controller.abort();
  }, [endpoint, runId, sessionId, requestKey]);

  const act = useCallback(async (action: () => Promise<void>) => {
    if (working.current || !runId || !sessionId) return;
    working.current = true;
    setBusy(true); setError(null); setNotice(null); setStatusSession(sessionId);
    try { await action(); }
    catch (reason) {
      if (mounted.current && currentSession.current === sessionId) setError(reason instanceof Error ? reason.message : "Unable to update Pins.");
    }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }, [runId, sessionId]);

  const remove = useCallback((pin: ConversationPin) => {
    void act(async () => {
      if (!runId) throw new Error("The selected Run is unavailable.");
      const response = await fetch(`${endpoint}?${new URLSearchParams({ runId, pinId: pin.id })}`, { method: "DELETE" });
      const body = await response.json();
      if (!response.ok || body.removed !== true) throw new Error(typeof body.error === "string" ? body.error : "Pin removal was not confirmed.");
      if (mounted.current && currentSession.current === sessionId) {
        setStoredPins((current) => ({ ...current, pins: current.pins.filter((entry) => entry.id !== pin.id) }));
        if (activePin?.id === pin.id) onActivePinChange(null);
        setNotice("Pin removed.");
      }
    });
  }, [act, endpoint, runId, activePin, onActivePinChange, sessionId]);

  const toggle = useCallback((eventId: string, line: number) => {
    const existing = pins.find((pin) => pin.eventId === eventId && pin.line === line);
    if (existing) { remove(existing); return; }
    void act(async () => {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, eventId, line }) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Unable to save Pin.");
      const parsed = conversationPinSchema.safeParse(body.pin);
      if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.eventId !== eventId || parsed.data.line !== line) {
        throw new Error("Pin acceptance was not confirmed. Retry the same line.");
      }
      if (mounted.current && currentSession.current === sessionId) {
        setStoredPins((current) => ({ sessionId, pins: [
          ...(current.sessionId === sessionId ? current.pins : []).filter((pin) => pin.id !== parsed.data.id), parsed.data,
        ] }));
        setNotice("Pin saved.");
      }
    });
  }, [act, endpoint, pins, remove, runId, sessionId]);

  const navigate = useCallback((pin: ConversationPin) => {
    void act(async () => {
      await onNavigate(pin);
      if (mounted.current && currentSession.current === sessionId) setNotice(`Located pinned line ${pin.line}.`);
    });
  }, [act, onNavigate, sessionId]);

  const context = useMemo(() => ({
    pins, loading, busy, activePin: activePin?.sessionId === sessionId ? activePin : null,
    error: statusSession === sessionId ? error : null, notice: statusSession === sessionId ? notice : null,
    toggle, remove, navigate, refresh: () => setVersion((current) => current + 1),
  }), [pins, loading, busy, activePin, error, notice, statusSession, sessionId, toggle, remove, navigate]);
  return <ConversationPinsContext.Provider value={sessionId ? context : null}>{children}</ConversationPinsContext.Provider>;
}

export function ConversationLinePin({ eventId, line }: { eventId: string; line: number }) {
  const context = useContext(ConversationPinsContext);
  if (!context) return null;
  const pinned = context.pins.some((pin) => pin.eventId === eventId && pin.line === line);
  return <button type="button" aria-label={`${pinned ? "Unpin" : "Pin"} output line ${line}`} aria-pressed={pinned}
    title={`${pinned ? "Unpin" : "Pin"} this paragraph or code line`}
    disabled={context.loading || context.busy} onClick={() => context.toggle(eventId, line)}
    className={`conversation-line-pin ${pinned ? "is-pinned" : ""}`}>
    {pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
  </button>;
}

export function ConversationPinsPanel() {
  const context = useContext(ConversationPinsContext);
  return <section aria-label="Conversation Pins" className={`conversation-pins-panel ${context?.pins.length ? "has-pins" : ""}`}>
    <div className="flex shrink-0 items-center justify-between gap-2">
      <h2 className="flex items-center gap-1 text-xs font-semibold text-neutral-300"><Pin size={13} aria-hidden="true" />Pins</h2>
      {context && <button type="button" title="Refresh Pins" aria-label="Refresh Pins" disabled={context.loading || context.busy}
        onClick={context.refresh} className="grid size-8 shrink-0 place-items-center rounded text-neutral-400 hover:bg-neutral-800">
        <RefreshCw size={12} aria-hidden="true" />
      </button>}
    </div>
    {context?.loading && <p role="status" className="flex items-center gap-1 text-xs text-neutral-500"><LoaderCircle size={12} className="animate-spin" aria-hidden="true" />Loading Pins...</p>}
    {context?.error && <p role="alert" className="shrink-0 text-xs text-red-400">{context.error}</p>}
    {context?.notice && <p role="status" className="sr-only">{context.notice}</p>}
    {!context?.loading && !context?.pins.length && <p className="text-[10px] text-neutral-500">Pin a paragraph or code line to return here later.</p>}
    <ol className="min-h-0 space-y-1 overflow-y-auto">
      {context?.pins.map((pin) => <li key={pin.id} className="flex min-w-0 items-start gap-1 rounded hover:bg-neutral-800">
        <button type="button" disabled={context.busy} onClick={() => context.navigate(pin)} title={pin.preview}
          aria-label={`Go to pinned line ${pin.line}: ${pin.preview}`} className="min-h-11 min-w-0 flex-1 p-1 text-left">
          <span className="block text-[10px] text-neutral-500">Line {pin.line}{pin.timestamp ? ` · ${new Date(pin.timestamp).toLocaleTimeString()}` : ""}</span>
          <span className="line-clamp-2 break-words text-xs text-neutral-300">{pin.preview}</span>
        </button>
        <button type="button" aria-label={`Remove Pin: ${pin.preview}`} title="Remove Pin" disabled={context.busy}
          onClick={() => context.remove(pin)} className="grid size-8 shrink-0 place-items-center text-neutral-500 hover:text-red-400">
          <X size={12} aria-hidden="true" />
        </button>
      </li>)}
    </ol>
  </section>;
}
