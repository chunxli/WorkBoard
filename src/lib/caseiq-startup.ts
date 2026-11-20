import { z } from "zod";

export const caseIqStartupPhaseSchema = z.enum([
  "checking", "session", "launcher", "accepted", "native", "processing", "stopping",
]);
export type CaseIqStartupPhase = z.infer<typeof caseIqStartupPhaseSchema>;

const caseIqStartupStateSchema = z.object({
  phase: caseIqStartupPhaseSchema,
  attempt: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  steps: z.array(z.object({ phase: caseIqStartupPhaseSchema, at: z.iso.datetime() })).max(7),
});
export type CaseIqStartupState = z.infer<typeof caseIqStartupStateSchema>;

export const caseIqStartupObservationSchema = z.object({
  runId: z.string().min(1),
  status: z.string(),
  startedAt: z.iso.datetime(),
  startup: caseIqStartupStateSchema.nullable(),
  unavailableReason: z.string().nullable(),
});
export type CaseIqStartupObservation = z.infer<typeof caseIqStartupObservationSchema>;

export const caseIqStartupPhases: Record<CaseIqStartupPhase, { label: string; detail: string }> = {
  checking: {
    label: "Checking the trusted runtime",
    detail: "Recording this Run's CaseIQ version and checking the PowerShell host and existing Session.",
  },
  session: {
    label: "Preparing the Session",
    detail: "Preparing private runtime files and this Session's MCP configuration.",
  },
  launcher: {
    label: "Initializing CaseIQ",
    detail: "The original launcher is preparing its dependencies, support packs and MCP configuration. No Terminal will open.",
  },
  accepted: {
    label: "Starting the native runtime",
    detail: "Preparation was accepted. Waiting for confirmation that the Prompt process started.",
  },
  native: {
    label: "Starting the CaseIQ Session",
    detail: "The native process has started; it may still be loading the Session/MCPs or waiting for model activity.",
  },
  processing: {
    label: "CaseIQ is working on your Prompt",
    detail: "This Run has reported native assistant or tool activity. Responses remain in the conversation.",
  },
  stopping: {
    label: "Stopping CaseIQ",
    detail: "Waiting for preparation to return or for the owned process to stop safely.",
  },
};
