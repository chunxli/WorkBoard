const globalForRunStartLock = globalThis as unknown as {
  workBoardRunStartLocks?: Set<string>;
};
const activeRunStartLocks =
  globalForRunStartLock.workBoardRunStartLocks ?? new Set<string>();
globalForRunStartLock.workBoardRunStartLocks = activeRunStartLocks;

export class RunStartInProgressError extends Error {
  constructor() {
    super("A Run is already being started for this Work or session");
    this.name = "RunStartInProgressError";
  }
}

export async function withRunStartLock<T>(
  keys: string[],
  operation: () => Promise<T>
): Promise<T> {
  const uniqueKeys = [...new Set(keys)].sort();
  if (uniqueKeys.some((key) => activeRunStartLocks.has(key))) {
    throw new RunStartInProgressError();
  }
  uniqueKeys.forEach((key) => activeRunStartLocks.add(key));
  try {
    return await operation();
  } finally {
    uniqueKeys.forEach((key) => activeRunStartLocks.delete(key));
  }
}