import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ManagedSessionController,
  registerManagedSessionController,
  unregisterManagedSessionController,
  type ManagedSessionTransport,
} from "@/lib/managed-session-controller";
import type { WorkSteeringMessageRecord } from "@/lib/work-steering";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  workFindFirst: vi.fn(),
  runFindFirst: vi.fn(),
  messageFindUnique: vi.fn(),
  messageCreate: vi.fn(),
  messageUpdate: vi.fn(),
  appendArtifact: vi.fn(),
  ensurePrompt: vi.fn(),
  resolveAttachments: vi.fn(),
  runtimeAttachments: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.getSessionUserId }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    work: { findFirst: mocks.workFindFirst },
    run: { findFirst: mocks.runFindFirst },
    workSteeringMessage: {
      findUnique: mocks.messageFindUnique,
      create: mocks.messageCreate,
      update: mocks.messageUpdate,
    },
  },
}));
vi.mock("@/lib/run-artifacts", () => ({
  getWorkRunArtifactPaths: () => ({ outputDirectory: "output" }),
  appendWorkRunSteeringArtifact: mocks.appendArtifact,
}));
vi.mock("@/lib/work-executor", () => ({ ensureSteeringPrompt: mocks.ensurePrompt }));
vi.mock("@/lib/work-attachments", async (original) => ({
  ...await original<typeof import("@/lib/work-attachments")>(),
  resolveWorkAttachments: mocks.resolveAttachments, runtimeWorkAttachments: mocks.runtimeAttachments,
}));

import { POST } from "./route";

const work = {
  id: "work-1",
  directoryPath: "C:\\work",
  promptFileName: "PROMPT.md",
  status: "ACTIVE",
  hostname: hostname(),
};
const run = {
  id: "run-1",
  status: "RUNNING",
  trigger: "WORK",
  engine: "SDK",
  hostname: hostname(),
  copilotSessionId: "session-1",
  createdAt: new Date(),
};

describe("Work Steering API", () => {
  let stored: WorkSteeringMessageRecord | null;
  let controller: ManagedSessionController;
  let runId: string;
  let send: ManagedSessionTransport["send"];

  beforeEach(() => {
    vi.clearAllMocks();
    stored = null;
    runId = run.id;
    send = vi.fn(async () => "transport-ack");
    controller = new ManagedSessionController({ send, abort: async () => {} });
    registerManagedSessionController(runId, controller);
    mocks.getSessionUserId.mockResolvedValue("owner-1");
    mocks.workFindFirst.mockResolvedValue(work);
    mocks.runFindFirst.mockResolvedValue(run);
    mocks.messageFindUnique.mockImplementation(async () => stored);
    mocks.messageCreate.mockImplementation(async ({ data }) => {
      stored = {
        ...data,
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
      return stored;
    });
    mocks.messageUpdate.mockImplementation(async ({ where, data }) => {
      if (!stored || stored.id !== where.id) throw new Error("message missing");
      stored = { ...stored, ...data };
      return stored;
    });
    mocks.appendArtifact.mockResolvedValue(undefined);
    mocks.ensurePrompt.mockResolvedValue(undefined);
    mocks.resolveAttachments.mockResolvedValue([]);
    mocks.runtimeAttachments.mockResolvedValue([]);
  });

  async function post(input: Record<string, unknown>, workId = "work-1") {
    return POST(
      new Request("http://localhost/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }) as never,
      { params: Promise.resolve({ id: workId }) }
    );
  }

  it("requires authentication and constrains the Run lookup to its Work", async () => {
    mocks.getSessionUserId.mockResolvedValueOnce(null);
    const unauthorized = await post({ prompt: "steer", requestId: randomUUID(), runId: run.id, sessionId: run.copilotSessionId });
    expect(unauthorized.status).toBe(401);

    mocks.runFindFirst.mockResolvedValueOnce(null);
    const crossWork = await post({ prompt: "steer", requestId: randomUUID(), runId: "foreign-run", sessionId: run.copilotSessionId });
    expect(crossWork.status).toBe(409);
    expect(mocks.runFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "foreign-run", workId: "work-1", experimentVariantId: null },
    }));
  });

  it("rejects archived, cross-host, external-Terminal and stale-session attempts", async () => {
    const request = { prompt: "steer", requestId: randomUUID(), runId: run.id, sessionId: run.copilotSessionId };
    mocks.workFindFirst.mockResolvedValueOnce({ ...work, status: "ARCHIVED" });
    expect((await post(request)).status).toBe(409);
    expect(send).not.toHaveBeenCalled();

    mocks.runFindFirst.mockResolvedValueOnce({ ...run, hostname: "other-host" });
    expect((await post({ ...request, requestId: randomUUID() })).status).toBe(409);
    expect(send).not.toHaveBeenCalled();

    mocks.runFindFirst.mockResolvedValueOnce({ ...run, trigger: "TERMINAL_RESUME" });
    expect((await post({ ...request, requestId: randomUUID() })).status).toBe(409);
    expect(send).not.toHaveBeenCalled();

    expect((await post({ ...request, requestId: randomUUID(), sessionId: "stale-session" })).status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts the same idempotent message once and repairs neither Prompt nor transport twice", async () => {
    const request = {
      prompt: "Keep the current task focused",
      requestId: randomUUID(),
      runId: run.id,
      sessionId: run.copilotSessionId,
    };
    const first = await post(request);
    const firstBody = await first.json();
    expect(first.status).toBe(202);
    expect(firstBody).toMatchObject({
      deliveryState: "ACCEPTED",
      transportAccepted: true,
      promptSynced: true,
      artifactSynced: true,
    });

    const retry = await post(request);
    expect(retry.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.ensurePrompt).toHaveBeenCalledOnce();
    expect(stored?.promptSynced).toBe(true);
    expect(mocks.workFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "work-1", userId: "owner-1" },
    }));
  });

  it("rejects native CLI Steering before creating a message, resolving files or sending", async () => {
    mocks.runFindFirst.mockResolvedValue({ ...run, engine: "CLI" });
    const response = await post({ prompt: "Do not send this", requestId: randomUUID(), runId: run.id, sessionId: run.copilotSessionId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Native CLI Runs do not support Steering") });
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(mocks.resolveAttachments).not.toHaveBeenCalled();
    expect(mocks.appendArtifact).not.toHaveBeenCalled();
    expect(mocks.ensurePrompt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("repairs an already accepted legacy CLI record without replaying its transport", async () => {
    const requestId = randomUUID();
    mocks.runFindFirst.mockResolvedValue({ ...run, engine: "CLI", status: "SUCCESS" });
    stored = {
      id: "legacy", workId: work.id, runId: run.id, sessionId: run.copilotSessionId, requestId,
      content: "Accepted before the runtime split", deliveryState: "ACCEPTED", transportMessageId: "legacy-ack",
      promptSynced: false, promptError: null, artifactSynced: false, artifactError: null,
      createdAt: new Date(), acceptedAt: new Date(), observedAt: null,
    };
    const response = await post({ prompt: stored.content, requestId, runId: run.id, sessionId: run.copilotSessionId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ promptSynced: true, artifactSynced: true });
    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.ensurePrompt).toHaveBeenCalledOnce();
  });

  it("leaves an accepted message visible when Prompt repair fails, then repairs by the same key", async () => {
    mocks.ensurePrompt.mockRejectedValueOnce(new Error("dirty editor failure")).mockResolvedValueOnce(undefined);
    const request = {
      prompt: "Retain the changed API",
      requestId: randomUUID(),
      runId: run.id,
      sessionId: run.copilotSessionId,
    };
    const first = await post(request);
    expect(await first.json()).toMatchObject({
      deliveryState: "ACCEPTED",
      transportAccepted: true,
      promptSynced: false,
      artifactSynced: true,
    });
    const repaired = await post(request);
    expect(await repaired.json()).toMatchObject({ promptSynced: true, artifactSynced: true });
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.ensurePrompt).toHaveBeenCalledTimes(2);
  });

  it("does not replay a record left submitting by a process restart", async () => {
    stored = {
      id: "existing",
      workId: "work-1",
      runId: run.id,
      sessionId: run.copilotSessionId,
      requestId: "8e2e2f5e-84c5-4d00-98a7-e443c268cb9a",
      content: "Maybe already delivered",
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
    const response = await post({
      prompt: stored.content,
      requestId: stored.requestId,
      runId: run.id,
      sessionId: run.copilotSessionId,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ deliveryState: "UNCERTAIN" });
    expect(stored.deliveryState).toBe("UNCERTAIN");
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers attachment-only Steering through the immediate transport and binds retries to the same files", async () => {
    const requestId = randomUUID(); const id = randomUUID();
    const file = { id, requestId, uploadId: randomUUID(), name: "diagram.png", storedName: `${id}-diagram.png`, size: 20, mediaType: "image/png", sha256: "a".repeat(64) };
    const transport = [{ type: "file", path: "C:\\synthetic\\diagram.png", displayName: file.name }];
    mocks.resolveAttachments.mockResolvedValue([file]); mocks.runtimeAttachments.mockResolvedValue(transport);
    const input = { prompt: "", requestId, runId: run.id, sessionId: run.copilotSessionId, attachmentIds: [id] };
    expect((await post(input)).status).toBe(202);
    expect(send).toHaveBeenCalledWith({ prompt: "Please review the attached files.", mode: "immediate", attachments: transport });
    expect(stored?.attachmentsJson).toBe(JSON.stringify([file]));
    expect(mocks.appendArtifact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ attachments: [file] }));
    expect((await post(input)).status).toBe(200);
    expect(send).toHaveBeenCalledOnce(); expect(mocks.runtimeAttachments).toHaveBeenCalledOnce();
    expect((await post({ ...input, attachmentIds: [randomUUID()] })).status).toBe(409);
  });

  it("rejects invalid files before transport instead of declaring uncertain delivery", async () => {
    mocks.runtimeAttachments.mockRejectedValue(new Error("Saved attachment changed"));
    const response = await post({ prompt: "Read the file", requestId: randomUUID(), runId: run.id, sessionId: run.copilotSessionId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ deliveryState: "REJECTED", error: "Saved attachment changed" });
    expect(send).not.toHaveBeenCalled();
    expect(stored?.deliveryState).toBe("REJECTED");
    expect(controller.canAcceptSteering).toBe(true);
  });

  afterEach(() => unregisterManagedSessionController(runId, controller));
});
