import { describe, expect, it, vi } from "vitest";
import { ManagedSessionController } from "@/lib/managed-session-controller";
import {
  getSteeringAvailabilityReason,
  processWorkSteeringMessage,
  SteeringRequestError,
  type SteeringMessageRepository,
  type WorkSteeringMessageRecord,
} from "./work-steering";

function message(): WorkSteeringMessageRecord {
  return {
    id: "steering-1",
    workId: "work-1",
    runId: "run-1",
    sessionId: "session-1",
    requestId: "request-1",
    content: "Do not change the API shape",
    deliveryState: "SUBMITTING",
    transportMessageId: null,
    promptSynced: false,
    promptError: null,
    artifactSynced: false,
    artifactError: null,
    createdAt: new Date(),
    acceptedAt: null,
    observedAt: null,
  };
}

function repository(initial: WorkSteeringMessageRecord) {
  let current = initial;
  const store: SteeringMessageRepository = {
    update: vi.fn(async (_id, changes) => {
      current = { ...current, ...changes };
      return current;
    }),
  };
  return { store, current: () => current };
}

function controller(send: () => Promise<{ messageId: string }>) {
  return new ManagedSessionController({
    send,
    abort: async () => {},
  });
}

describe("getSteeringAvailabilityReason", () => {
  const eligible = {
    workStatus: "ACTIVE",
    workHostname: "host-a",
    currentHostname: "host-a",
    run: {
      status: "RUNNING",
      trigger: "WORK",
      engine: "CLI",
      hostname: "host-a",
      sessionId: "session-1",
    },
    expectedSessionId: "session-1",
    controller: controller(() => Promise.resolve({ messageId: "ack" })),
  };

  it("allows only the current managed Run/session with a live accepting controller", () => {
    expect(getSteeringAvailabilityReason(eligible)).toBeNull();
    expect(getSteeringAvailabilityReason({
      ...eligible,
      run: { ...eligible.run, sessionId: "session-2" },
    })).toContain("no longer match");
    expect(getSteeringAvailabilityReason({
      ...eligible,
      workHostname: "host-b",
    })).toContain("another machine");
    expect(getSteeringAvailabilityReason({
      ...eligible,
      workStatus: "ARCHIVED",
    })).toContain("Restore");
    expect(getSteeringAvailabilityReason({
      ...eligible,
      run: { ...eligible.run, trigger: "TERMINAL_RESUME" },
    })).toContain("read-only");
    expect(getSteeringAvailabilityReason({
      ...eligible,
      controller: null,
    })).toContain("controller");
  });
});

describe("processWorkSteeringMessage", () => {
  it("accepts once and uses a duplicate request to repair Prompt without another send", async () => {
    const record = message();
    const db = repository(record);
    const send = vi.fn(async () => ({ messageId: "transport-ack" }));
    const appendArtifact = vi.fn(async () => {});
    const appendPrompt = vi.fn(async () => {});
    const options = {
      message: record,
      newlyCreated: true,
      controller: controller(send),
      repository: db.store,
      appendArtifact,
      appendPrompt,
    };

    await expect(processWorkSteeringMessage(options)).resolves.toMatchObject({
      transportAccepted: true,
      promptSynced: true,
      artifactSynced: true,
    });
    const acceptedRecord = db.current();
    await expect(processWorkSteeringMessage({
      ...options,
      message: acceptedRecord,
      newlyCreated: false,
      controller: null,
    })).resolves.toMatchObject({ transportAccepted: true, promptSynced: true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ prompt: record.content, mode: "immediate" });
    expect(appendPrompt).toHaveBeenCalledTimes(1);
    expect(appendArtifact).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent deliveries with the same idempotency key", async () => {
    let accept!: (value: { messageId: string }) => void;
    const send = vi.fn(() => new Promise<{ messageId: string }>((resolve) => { accept = resolve; }));
    const record = message();
    const db = repository(record);
    const options = {
      message: record,
      newlyCreated: true,
      controller: controller(send),
      repository: db.store,
      appendArtifact: vi.fn(async () => {}),
      appendPrompt: vi.fn(async () => {}),
    };

    const first = processWorkSteeringMessage(options);
    const retry = processWorkSteeringMessage(options);
    expect(send).toHaveBeenCalledOnce();
    accept({ messageId: "ack" });
    await expect(Promise.all([first, retry])).resolves.toHaveLength(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps an uncertain send from being replayed after a transport error", async () => {
    const record = message();
    const db = repository(record);
    const send = vi.fn(async () => { throw new Error("connection dropped after send"); });
    const options = {
      message: record,
      newlyCreated: true,
      controller: controller(send),
      repository: db.store,
      appendArtifact: vi.fn(async () => {}),
      appendPrompt: vi.fn(async () => {}),
    };

    await expect(processWorkSteeringMessage(options)).rejects.toMatchObject({
      status: 503,
      deliveryState: "UNCERTAIN",
    });
    await expect(processWorkSteeringMessage({
      ...options,
      message: db.current(),
      newlyCreated: false,
      controller: null,
    })).rejects.toThrow(SteeringRequestError);
    expect(send).toHaveBeenCalledOnce();
  });

  it("repairs an accepted Prompt failure by request ID without a second transport send", async () => {
    const record = message();
    const db = repository(record);
    const send = vi.fn(async () => ({ messageId: "ack" }));
    const appendPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("Prompt editor conflict"))
      .mockResolvedValueOnce(undefined);
    const options = {
      message: record,
      newlyCreated: true,
      controller: controller(send),
      repository: db.store,
      appendArtifact: vi.fn(async () => {}),
      appendPrompt,
    };

    await expect(processWorkSteeringMessage(options)).resolves.toMatchObject({
      transportAccepted: true,
      promptSynced: false,
    });
    await expect(processWorkSteeringMessage({
      ...options,
      message: db.current(),
      newlyCreated: false,
      controller: null,
    })).resolves.toMatchObject({ transportAccepted: true, promptSynced: true });
    expect(send).toHaveBeenCalledOnce();
    expect(appendPrompt).toHaveBeenCalledTimes(2);
  });

  it("rejects a new message when the managed session has stopped accepting Steering", async () => {
    const record = message();
    const controllerInstance = controller(() => Promise.resolve({ messageId: "ack" }));
    controllerInstance.observeIdle();
    const db = repository(record);

    await expect(processWorkSteeringMessage({
      message: record,
      newlyCreated: true,
      controller: controllerInstance,
      repository: db.store,
      appendArtifact: vi.fn(async () => {}),
      appendPrompt: vi.fn(async () => {}),
    })).rejects.toMatchObject({ deliveryState: "REJECTED" });
    expect(db.current().deliveryState).toBe("REJECTED");
  });
});
