/** Formats a run's elapsed time (or in-progress elapsed time) as a short human string. */
export function formatDuration(startedAt: Date | string | null, finishedAt: Date | string | null): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));

  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: tokens >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(tokens);
}
