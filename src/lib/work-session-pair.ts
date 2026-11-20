import { z } from "zod";

export const pairedWorkLanes = ["CLI", "CASEIQ"] as const;
export type PairedWorkLane = typeof pairedWorkLanes[number];

export const pairedLaneInfo = {
  CLI: { label: "Copilot CLI", folder: "copilot-cli" },
  CASEIQ: { label: "CaseIQ", folder: "caseiq" },
} as const;

export interface WorkSessionPairIds {
  cliSessionId: string;
  caseIqSessionId: string;
}

export function pairedSessionId(pair: WorkSessionPairIds, lane: PairedWorkLane): string {
  return lane === "CLI" ? pair.cliSessionId : pair.caseIqSessionId;
}

export function pairedOutputFolder(pair: WorkSessionPairIds): string {
  return `work-results-${pair.cliSessionId}`;
}

export function pairedWorkLane(pair: WorkSessionPairIds, sessionId: string | null): PairedWorkLane | null {
  return pairedWorkLanes.find((lane) => pairedSessionId(pair, lane) === sessionId) ?? null;
}

const laneSchema = z.enum(pairedWorkLanes);
const target = z.object({ lane: laneSchema, expectedParentRunId: z.string().min(1).max(128) }).strict();
const attachmentIds = z.array(z.string().uuid()).max(10).refine((ids) => new Set(ids).size === ids.length);

export const pairedWorkRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({
    action: z.literal("follow-up"),
    requestId: z.uuid(),
    prompt: z.string().trim().max(100_000),
    targets: z.array(target).min(1).max(2).refine((targets) => new Set(targets.map(({ lane }) => lane)).size === targets.length),
    attachmentIds: attachmentIds.default([]),
  }).strict().refine((value) => value.prompt.length > 0 || value.attachmentIds.length > 0, "Enter a prompt or attach a file."),
]);

export type PairedWorkFollowUp = Extract<z.infer<typeof pairedWorkRequest>, { action: "follow-up" }>;

export const pairedWorkReceipt = z.object({
  runs: z.array(z.object({ lane: laneSchema, runId: z.uuid(), sessionId: z.uuid(), queued: z.boolean() }).strict()).min(1).max(2),
}).strict();

export type PairedWorkReceipt = z.infer<typeof pairedWorkReceipt>;

export function readPairedFollowUpReceipt(value: unknown, destinations: readonly {
  lane: PairedWorkLane; sessionId: string;
}[]): PairedWorkReceipt | null {
  const parsed = pairedWorkReceipt.safeParse(value);
  if (!parsed.success || parsed.data.runs.length !== destinations.length ||
      new Set(parsed.data.runs.map((run) => run.runId)).size !== destinations.length) return null;
  const runs: PairedWorkReceipt["runs"] = [];
  for (const { lane, sessionId } of destinations) {
    const run = parsed.data.runs.find((run) => run.lane === lane && run.sessionId === sessionId);
    if (!run) return null;
    runs.push(run);
  }
  return { runs };
}
