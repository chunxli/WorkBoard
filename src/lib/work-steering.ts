import type {
  ManagedSessionController,
  SteeringAcceptance,
} from "@/lib/managed-session-controller";
import { isTerminalRunTrigger } from "@/lib/terminal-run";

export type SteeringDeliveryState =
  | "SUBMITTING"
  | "ACCEPTED"
  | "OBSERVED"
  | "UNCERTAIN"
  | "REJECTED";

export interface WorkSteeringMessageRecord {
  id: string;
  workId: string;
  runId: string;
  sessionId: string;
  requestId: string;
  content: string;
  deliveryState: SteeringDeliveryState;
  transportMessageId: string | null;
  promptSynced: boolean;
  promptError: string | null;
  artifactSynced: boolean;
  artifactError: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
  observedAt: Date | null;
}

export interface SteeringMessageRepository {
  update(
    id: string,
    changes: Partial<Pick<
      WorkSteeringMessageRecord,
      | "deliveryState"
      | "transportMessageId"
      | "promptSynced"
      | "promptError"
      | "artifactSynced"
      | "artifactError"
      | "acceptedAt"
      | "observedAt"
    >>
  ): Promise<WorkSteeringMessageRecord>;
}

export interface SteeringRepairResult {
  deliveryState: SteeringDeliveryState;
  transportAccepted: boolean;
  promptSynced: boolean;
  artifactSynced: boolean;
  message: string | null;
}

export class SteeringRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly deliveryState?: SteeringDeliveryState
  ) {
    super(message);
    this.name = "SteeringRequestError";
  }
}

export function getSteeringAvailabilityReason(input: {
  workStatus: string;
  workHostname: string | null;
  currentHostname: string;
  run: {
    status: string;
    trigger: string;
    engine: string | null;
    hostname: string | null;
    sessionId: string | null;
  };
  expectedSessionId: string;
  controller: ManagedSessionController | null;
}): string | null {
  if (input.workStatus === "ARCHIVED") return "Restore this Work before steering its Run.";
  if (input.run.sessionId !== input.expectedSessionId) return "The selected Run and session no longer match.";
  if (
    input.workHostname !== null && input.workHostname !== input.currentHostname ||
    input.run.hostname !== input.currentHostname
  ) return "This Run belongs to another machine.";
  if (isTerminalRunTrigger(input.run.trigger)) return "External Terminal sessions are read-only.";
  if (input.run.status !== "RUNNING") return "The selected Run is no longer active.";
  if (input.run.engine !== "CLI" && input.run.engine !== "SDK") {
    return "This Run has no supported live session transport.";
  }
  if (!input.controller) return "The managed live controller is unavailable or no longer accepting Steering.";
  if (!input.controller.canAcceptSteering) return "The Run is finishing and no longer accepting Steering.";
  return null;
}

const globalForSteering = globalThis as unknown as {
  workSteeringFlights?: Map<string, Promise<SteeringRepairResult>>;
};
const flights = globalForSteering.workSteeringFlights ?? new Map<string, Promise<SteeringRepairResult>>();
globalForSteering.workSteeringFlights = flights;

export function isWorkSteeringRequestInFlight(runId: string, requestId: string): boolean {
  return flights.has(`${runId}:${requestId}`);
}

export async function processWorkSteeringMessage(options: {
  message: WorkSteeringMessageRecord;
  newlyCreated: boolean;
  controller: ManagedSessionController | null;
  repository: SteeringMessageRepository;
  appendArtifact: (message: WorkSteeringMessageRecord) => Promise<void>;
  appendPrompt: (message: WorkSteeringMessageRecord) => Promise<void>;
}): Promise<SteeringRepairResult> {
  const { message } = options;
  const flightKey = `${message.runId}:${message.requestId}`;
  const active = flights.get(flightKey);
  if (active) return active;

  const operation = (async () => {
    if (!options.newlyCreated) {
      if (message.deliveryState === "SUBMITTING") {
        await options.repository.update(message.id, {
          deliveryState: "UNCERTAIN",
          promptError: "Transport acceptance is unknown; this request was not replayed.",
        }).catch(() => {});
        throw new SteeringRequestError(
          "Delivery status is unknown. This message was not resent; check the session history before creating a new instruction.",
          409,
          "UNCERTAIN"
        );
      }
      if (message.deliveryState === "UNCERTAIN") {
        throw new SteeringRequestError(
          "Delivery status is unknown. This message was not resent; check the session history before creating a new instruction.",
          409,
          "UNCERTAIN"
        );
      }
      if (message.deliveryState === "REJECTED") {
        throw new SteeringRequestError("This Steering request was rejected before transport acceptance.", 409, "REJECTED");
      }
      return repairAcceptedMessage(options);
    }

    if (message.deliveryState !== "SUBMITTING") {
      throw new SteeringRequestError("New Steering request was not in its initial state.", 409, message.deliveryState);
    }
    const reservation = options.controller?.reserveSteering() ?? null;
    if (!reservation) {
      await options.repository.update(message.id, {
        deliveryState: "REJECTED",
        promptError: "The managed session stopped accepting Steering before delivery.",
      });
      throw new SteeringRequestError(
        "The Run is no longer accepting Steering. The message was not sent.",
        409,
        "REJECTED"
      );
    }

    let acceptance: SteeringAcceptance;
    try {
      acceptance = await reservation.send(message.content);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await options.repository.update(message.id, {
        deliveryState: "UNCERTAIN",
        promptError: `Transport did not confirm acceptance: ${errorMessage}`,
      }).catch(() => {});
      throw new SteeringRequestError(
        "Transport acceptance could not be confirmed. This message was not resent; check session history before retrying with a new request.",
        503,
        "UNCERTAIN"
      );
    }

    let accepted: WorkSteeringMessageRecord;
    try {
      accepted = await options.repository.update(message.id, {
        deliveryState: "ACCEPTED",
        transportMessageId: acceptance.messageId,
        acceptedAt: new Date(),
        promptError: null,
      });
    } catch {
      await options.repository.update(message.id, {
        deliveryState: "UNCERTAIN",
        promptError: "Transport accepted the message, but acceptance could not be durably recorded.",
      }).catch(() => {});
      throw new SteeringRequestError(
        "The transport accepted the instruction, but its durable acceptance record could not be confirmed. Do not send it again.",
        503,
        "UNCERTAIN"
      );
    }

    return repairAcceptedMessage({ ...options, message: accepted });
  })();
  flights.set(flightKey, operation);
  try {
    return await operation;
  } finally {
    if (flights.get(flightKey) === operation) flights.delete(flightKey);
  }
}

async function repairAcceptedMessage(options: {
  message: WorkSteeringMessageRecord;
  repository: SteeringMessageRepository;
  appendArtifact: (message: WorkSteeringMessageRecord) => Promise<void>;
  appendPrompt: (message: WorkSteeringMessageRecord) => Promise<void>;
}): Promise<SteeringRepairResult> {
  let message = options.message;
  if (message.deliveryState !== "ACCEPTED" && message.deliveryState !== "OBSERVED") {
    throw new SteeringRequestError("Steering message has not been transport-accepted.", 409, message.deliveryState);
  }
  if (!message.artifactSynced) {
    try {
      await options.appendArtifact(message);
      message = await options.repository.update(message.id, { artifactSynced: true, artifactError: null });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message = await options.repository.update(message.id, { artifactError: detail }).catch(() => ({
        ...message,
        artifactError: detail,
      }));
    }
  }
  if (!message.promptSynced) {
    try {
      await options.appendPrompt(message);
      message = await options.repository.update(message.id, { promptSynced: true, promptError: null });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message = await options.repository.update(message.id, { promptError: detail }).catch(() => ({
        ...message,
        promptError: detail,
      }));
    }
  }
  const needsRepair = !message.artifactSynced || !message.promptSynced;
  return {
    deliveryState: message.deliveryState,
    transportAccepted: true,
    promptSynced: message.promptSynced,
    artifactSynced: message.artifactSynced,
    message: needsRepair
      ? `Accepted by the session, but ${[
          !message.artifactSynced ? "Run audit artifact" : null,
          !message.promptSynced ? "Prompt file" : null,
        ].filter(Boolean).join(" and ")} could not be updated. Retry this same request to repair without resending.`
      : null,
  };
}
