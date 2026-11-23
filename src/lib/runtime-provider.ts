export const CASEIQ_PROVIDER_ID = "caseiq";

export function isCaseIqRuntime(run: { providerId?: string | null }): boolean {
  return run.providerId === CASEIQ_PROVIDER_ID;
}

export function isCaseIqWebRun(run: { providerId?: string | null; engine?: string | null }): boolean {
  return isCaseIqRuntime(run) && run.engine === "CASEIQ";
}

export function runtimeProviderLabel(run: { providerId?: string | null; engine?: string | null }): string {
  if (run.providerId === CASEIQ_PROVIDER_ID) return run.engine === "CASEIQ" ? "CaseIQ" : "CaseIQ · Native Terminal";
  if (run.providerId) return `Unsupported runtime (${run.providerId})`;
  return run.engine === "SDK" ? "Copilot SDK" : "Copilot CLI";
}

export function webFollowUpBlockedReason(run: { providerId?: string | null; engine?: string | null }): string | null {
  if (run.providerId === CASEIQ_PROVIDER_ID) {
    if (run.engine === "CASEIQ") return null;
    return "This CaseIQ session uses native Terminal. Use Resume in Terminal; web Follow Up and Queue are not supported.";
  }
  return run.providerId ? "This runtime does not support web Follow Up." : null;
}
