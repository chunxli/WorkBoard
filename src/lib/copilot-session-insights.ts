import { CopilotCompletionTracker, type CopilotCompletionSummary } from "@/lib/copilot-completion";
import { readCompatibleCopilotSessionEvents } from "@/lib/copilot-session-compat";

interface ModelUsageMetrics {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface CopilotTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  models: string[];
  modelUsage: Record<string, ModelUsageMetrics>;
}

export interface CopilotSessionInsights {
  eventCount: number;
  completion: CopilotCompletionSummary;
  usage: CopilotTokenUsage | null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

function tokenDetail(data: Record<string, unknown>, name: string): number {
  const details = data.tokenDetails as Record<string, { tokenCount?: unknown }> | undefined;
  return nonNegativeNumber(details?.[name]?.tokenCount);
}

function parseUsage(event: unknown): CopilotTokenUsage | null {
  if (!event || typeof event !== "object") return null;
  const candidate = event as { type?: unknown; data?: Record<string, unknown> };
  if (candidate.type !== "session.shutdown" || !candidate.data) return null;

  const modelMetrics = candidate.data.modelMetrics as Record<string, {
    requests?: { count?: unknown };
    usage?: Record<string, unknown>;
  }> | undefined;
  const modelUsage: Record<string, ModelUsageMetrics> = {};
  for (const [model, metrics] of Object.entries(modelMetrics ?? {})) {
    const usage = metrics.usage ?? {};
    modelUsage[model] = {
      requests: nonNegativeNumber(metrics.requests?.count),
      inputTokens: nonNegativeNumber(usage.inputTokens),
      outputTokens: nonNegativeNumber(usage.outputTokens),
      cacheReadTokens: nonNegativeNumber(usage.cacheReadTokens),
      cacheWriteTokens: nonNegativeNumber(usage.cacheWriteTokens),
      reasoningTokens: nonNegativeNumber(usage.reasoningTokens),
    };
  }

  const uncachedInputTokens = tokenDetail(candidate.data, "input");
  const cacheReadTokens = tokenDetail(candidate.data, "cache_read");
  const cacheWriteTokens = tokenDetail(candidate.data, "cache_write");
  const detailInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const modelValues = Object.values(modelUsage);
  return {
    inputTokens: detailInputTokens || modelValues.reduce((total, item) => total + item.inputTokens, 0),
    outputTokens: tokenDetail(candidate.data, "output") || modelValues.reduce((total, item) => total + item.outputTokens, 0),
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: modelValues.reduce((total, item) => total + item.reasoningTokens, 0),
    models: Object.keys(modelUsage),
    modelUsage,
  };
}

export function analyzeCopilotSessionEvents(
  events: unknown[],
  fromEvent = 0
): CopilotSessionInsights {
  const tracker = new CopilotCompletionTracker();
  for (const event of events.slice(fromEvent)) {
    tracker.push(`${JSON.stringify(event)}\n`);
  }
  let usage: CopilotTokenUsage | null = null;
  for (let index = events.length - 1; index >= 0 && !usage; index--) {
    usage = parseUsage(events[index]);
  }
  return { eventCount: events.length, completion: tracker.finish(), usage };
}

export async function readCopilotSessionInsights(
  sessionId: string,
  fromEvent = 0
): Promise<CopilotSessionInsights> {
  return analyzeCopilotSessionEvents(
    await readCompatibleCopilotSessionEvents(sessionId),
    fromEvent
  );
}

export function subtractCopilotTokenUsage(
  current: CopilotTokenUsage | null,
  baseline: CopilotTokenUsage | null
): CopilotTokenUsage | null {
  if (!current) return null;
  const difference = (key: keyof Omit<CopilotTokenUsage, "models" | "modelUsage">) =>
    Math.max(0, current[key] - (baseline?.[key] ?? 0));
  const modelUsage: Record<string, ModelUsageMetrics> = {};
  for (const [model, usage] of Object.entries(current.modelUsage)) {
    const prior = baseline?.modelUsage[model];
    const delta = {
      requests: Math.max(0, usage.requests - (prior?.requests ?? 0)),
      inputTokens: Math.max(0, usage.inputTokens - (prior?.inputTokens ?? 0)),
      outputTokens: Math.max(0, usage.outputTokens - (prior?.outputTokens ?? 0)),
      cacheReadTokens: Math.max(0, usage.cacheReadTokens - (prior?.cacheReadTokens ?? 0)),
      cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - (prior?.cacheWriteTokens ?? 0)),
      reasoningTokens: Math.max(0, usage.reasoningTokens - (prior?.reasoningTokens ?? 0)),
    };
    if (delta.requests > 0 || delta.inputTokens > 0 || delta.outputTokens > 0) {
      modelUsage[model] = delta;
    }
  }
  return {
    inputTokens: difference("inputTokens"),
    outputTokens: difference("outputTokens"),
    cacheReadTokens: difference("cacheReadTokens"),
    cacheWriteTokens: difference("cacheWriteTokens"),
    reasoningTokens: difference("reasoningTokens"),
    models: Object.keys(modelUsage),
    modelUsage,
  };
}

export function serializeCopilotTokenUsage(usage: CopilotTokenUsage | null) {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    modelsUsed: usage?.models.length ? JSON.stringify(usage.models) : null,
  };
}