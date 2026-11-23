function hasRecordedError(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0
    : value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function toolExecutionFailed(data: Record<string, unknown>): boolean {
  if (data.success === false || hasRecordedError(data.error)) return true;
  const result = data.result;
  return result !== null && typeof result === "object" && "error" in result && hasRecordedError(result.error);
}
