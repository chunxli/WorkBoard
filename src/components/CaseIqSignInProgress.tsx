import { CheckCircle2, Circle, CircleAlert, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { CASEIQ_AUTHENTICATION_COMMAND, type CaseIqAuthenticationStatus } from "@/lib/caseiq-options";

export default function CaseIqSignInProgress({ status, opening, uncertain, error, commandCopied, clipboardError, compact = false, actions }: {
  status: CaseIqAuthenticationStatus | null; opening: boolean; uncertain: boolean; error: string | null;
  commandCopied: boolean; clipboardError: string | null;
  compact?: boolean; actions?: ReactNode;
}) {
  const pending = Boolean(status?.automaticSignIn && !status.automaticSignIn.attempted);
  const otherSession = Boolean(status?.sessionId && status.operation && status.operation.sessionId !== status.sessionId);
  const operation = otherSession || pending && !status?.operation?.reserved &&
    status?.operation?.id !== status?.automaticSignIn?.requestId ? null : status?.operation;
  const otherWindowOpen = otherSession && Boolean(status?.operation?.reserved);
  const needsAuthentication = status?.connection?.status === "needs-auth";
  if (!operation && !pending && !opening && !uncertain && !otherWindowOpen && !needsAuthentication) return null;
  const verified = Boolean(status?.authenticationVerified && status.connection?.status === "connected");
  const reserved = Boolean(operation?.reserved);
  const ready = operation?.phase === "native-started" || verified;
  const failed = Boolean(error || uncertain || operation?.status === "failed" || operation?.status === "unconfirmed");
  const waiting = pending && !status?.available && !reserved && !opening && !otherWindowOpen;
  const closedUnverified = Boolean(operation && !reserved && !verified && !opening);
  const finished = verified && !reserved && !opening && !failed;
  const preparing = opening || operation?.status === "opening" || reserved && !ready;
  if (compact && finished) return null;
  let title: string;
  let next: string;
  let current = -1;
  if (otherWindowOpen) {
    title = "Another Session of this Work has a sign-in window";
    next = "Finish and close that original sign-in window first. WorkBoard will not replace its Session or open a competing Terminal.";
  } else if (failed) {
    title = uncertain || operation?.status === "unconfirmed" ? "Window acceptance or stop is unconfirmed" : "Sign-in needs attention";
    next = "Check the original Terminal and refresh sign-in state. Do not open another window until the current request is resolved.";
  } else if (waiting) {
    title = "Waiting for this Work's Runs and queued messages";
    next = "When this Work is idle, its original sign-in Terminal will open automatically. Stay on this Conversation; no failed Prompt will be replayed.";
    current = 0;
  } else if (finished) {
    title = "Native OAuth check completed";
    next = status?.available ? "Send a new Follow Up when ready. Earlier failed requests were not replayed."
      : "This Work still has active or queued Runs. Let them finish before a new Follow Up; a historical OAuth check is not a new sign-in requirement.";
  } else if (verified && reserved) {
    title = "OAuth checked; waiting for the Terminal to close";
    next = "Exit Copilot and close its sign-in Terminal. WorkBoard will detect the stop and release this Work automatically.";
    current = 4;
  } else if (preparing) {
    title = operation ? "Preparing the original CaseIQ Session" : "Requesting the original sign-in Terminal";
    next = "Wait for CaseIQ to finish preparation. The selected exact-folder trust is applied before the native Session starts; no task Prompt is sent.";
    current = operation ? 1 : 0;
  } else if (ready && reserved) {
    title = "Waiting for TSE sign-in and native OAuth verification";
    next = `When the native prompt is ready, ${commandCopied ? "paste" : "type"} ${CASEIQ_AUTHENTICATION_COMMAND} in the Terminal, complete the official TSE sign-in, and keep it open until OAuth is checked here.`;
    current = 3;
  } else if (closedUnverified) {
    title = "Terminal closed; OAuth remains unverified";
    next = "Refresh sign-in state. If sign-in is still required, use the manual button to retry; this same requirement will not repeatedly open windows.";
  } else {
    title = "SupportIQ sign-in is required";
    next = pending ? "WorkBoard will request this Work's original Terminal when it is safe to open."
      : status?.available ? "Open the sign-in Terminal below, run the highlighted command and choose your TSE account. No task prompts."
        : status?.blockedReason ?? "Refresh sign-in state before opening the original Terminal.";
    current = pending ? 0 : -1;
  }
  const showCommand = !failed && !otherWindowOpen && !verified && !preparing && !waiting &&
    (ready && reserved || needsAuthentication && !reserved);
  const steps = [
    { label: "Request accepted", done: Boolean(operation) },
    { label: "Original Session prepared", done: ready },
    { label: "Native Session started", done: ready },
    { label: "TSE sign-in and OAuth checked", done: verified },
    { label: "Terminal closed; Work released", done: finished },
  ];
  return <section aria-label={compact ? "SupportIQ sign-in action" : "SupportIQ sign-in progress"}
    className={compact ? "caseiq-signin-callout mb-2 space-y-1.5 text-xs" : "mb-3 space-y-2 border-b border-neutral-800 pb-3"}>
    <p role="status" aria-live="polite" className={`flex items-center gap-2 font-semibold ${compact ? "text-amber-200" : "text-neutral-300"}`}>
      {current >= 0 && <LoaderCircle size={14} className="shrink-0 animate-spin motion-reduce:animate-none text-emerald-500" aria-hidden="true" />}
      {finished && <CheckCircle2 size={14} className="shrink-0 text-emerald-400" aria-hidden="true" />}
      {(failed || closedUnverified || needsAuthentication && !reserved && !pending && !opening) &&
        <CircleAlert size={14} className="shrink-0 text-amber-400" aria-hidden="true" />}
      {title}
    </p>
    <p aria-label="Next sign-in action" className={compact ? "break-words" : "caseiq-signin-next break-words"}>
      <strong className="text-amber-200">Next: </strong>
      {compact && showCommand && ready && reserved ? <>In Terminal: run the command, choose your <strong>TSE account</strong>,
        then <strong>exit Copilot</strong> after OAuth is checked. <strong>No task prompts.</strong></> : next}
    </p>
    {showCommand && <code className="caseiq-signin-command">{CASEIQ_AUTHENTICATION_COMMAND}</code>}
    {(!compact || operation || opening) && <ol aria-label="Sign-in steps" className={compact ? "flex flex-wrap items-center gap-2" : "grid gap-x-4 gap-y-1.5 sm:grid-cols-2"}>
      {steps.map((step, index) => {
        const state = step.done ? "complete" : index === current ? "current" : "pending";
        const Icon = step.done ? CheckCircle2 : index === current ? LoaderCircle : Circle;
        return <li key={step.label} data-state={state} title={compact ? `${state}: ${step.label}` : undefined}
          aria-current={state === "current" ? "step" : undefined}
          className={`flex min-w-0 items-center gap-1.5 ${state === "complete" ? "text-emerald-400" : state === "current" ? "text-neutral-300" : "text-neutral-500"}`}>
          <Icon size={12} className={`shrink-0${state === "current" ? " animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
          <span className="sr-only">{state}: </span><span className={compact ? "sr-only" : undefined}>{step.label}</span>
        </li>;
      })}
    </ol>}
    {actions}
    {!compact && operation?.phase === "native-started" && operation.trustWorkFolder && <p className="text-neutral-400">Only this Work&apos;s exact folder was trusted for this sign-in operation.</p>}
    {!compact && commandCopied && <p className="text-neutral-400">Authentication command copied. No login command or task was executed automatically.</p>}
    {clipboardError && <p role="alert" className="text-amber-400">Clipboard unavailable: {clipboardError} Type {CASEIQ_AUTHENTICATION_COMMAND} when the original native prompt is ready. Nothing is executed automatically.</p>}
  </section>;
}
