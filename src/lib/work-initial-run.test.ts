import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveWorkAttachment, resolveWorkAttachments, runtimeWorkAttachments, parseWorkAttachments } from "./work-attachments";

const mocks = vi.hoisted(() => ({ work: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  work: { findUniqueOrThrow: mocks.work }, run: { create: mocks.create },
} }));
import { createPendingWorkRun } from "./work-executor";

let root: string;
let work: { id: string; directoryPath: string };
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "workboard-initial-run-"));
  work = { id: randomUUID(), directoryPath: root };
  mocks.work.mockResolvedValue(work);
  mocks.create.mockImplementation(async ({ data }) => data);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("initial Prompt files in managed Run metadata", () => {
  it.each(["CLI", "SDK"] as const)("retains initial image metadata for the %s engine's native file transport", async (engine) => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const file = await saveWorkAttachment({
      work, requestId: work.id, uploadId: randomUUID(), name: "evidence.png", size: bytes.length,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    });
    await resolveWorkAttachments(work, work.id, [file.id], true);
    const run = await createPendingWorkRun({
      workId: work.id, engine, executionPath: root, prompt: "Review evidence", concurrencyMode: "DIRECT",
    });
    expect(run.engine).toBe(engine);
    const saved = parseWorkAttachments(run.attachmentsJson);
    expect(saved).toEqual([file]);
    expect(await runtimeWorkAttachments(work, saved)).toEqual([{
      type: "file", displayName: "evidence.png",
      path: path.join(root, ".workboard", "attachments", work.id, work.id, file.storedName),
    }]);
  });

  it("preserves attachment-free Runs and prevents starting a partially uploaded initial draft", async () => {
    const options = { workId: work.id, engine: "CLI" as const, executionPath: root, prompt: "Plain Prompt", concurrencyMode: "DIRECT" };
    expect((await createPendingWorkRun(options)).attachmentsJson).toBeNull();
    await saveWorkAttachment({
      work, requestId: work.id, uploadId: randomUUID(), name: "empty.txt", size: 0, body: null,
    });
    await expect(createPendingWorkRun(options)).rejects.toThrow("Finish saving");
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
