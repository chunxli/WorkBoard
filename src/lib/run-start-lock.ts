const globalForRunStartLock = globalThis as unknown as {
  workBoardRunStartLocks?: Set<string>;
};
const activeRunStartLocks =
  globalForRunStartLock.workBoardRunStartLocks ?? new Set<string>();
globalForRunStartLock.workBoardRunStartLocks = activeRunStartLocks;

export class RunStartInProgressError extends Error {
  constructor(message = "A Run is already being started for this Work or session") {
    super(message);
    this.name = "RunStartInProgressError";
  }
}

export async function withRunStartLock<T>(
  keys: string[],
  operation: () => Promise<T>,
  { checkWorkAuthentication = true }: { checkWorkAuthentication?: boolean } = {},
): Promise<T> {
  const uniqueKeys = [...new Set(keys)].sort();
  if (uniqueKeys.some((key) => activeRunStartLocks.has(key))) {
    throw new RunStartInProgressError();
  }
  uniqueKeys.forEach((key) => activeRunStartLocks.add(key));
  try {
    const reason = await caseIqAuthenticationBlockedReason(
      checkWorkAuthentication ? uniqueKeys : uniqueKeys.filter((key) => key.startsWith("session:")),
    );
    if (reason) throw new RunStartInProgressError(reason);
    return await operation();
  } finally {
    uniqueKeys.forEach((key) => activeRunStartLocks.delete(key));
  }
}
import { caseIqAuthenticationBlockedReason } from "@/lib/caseiq-authentication-state";
