import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  query: vi.fn(), update: vi.fn(), cancel: vi.fn(), cancelSdk: vi.fn(), finalize: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "status-owner" }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findFirst: services.query, update: services.update } } }));
vi.mock("@/lib/copilot-runner", () => ({ cancelRun: services.cancel }));
vi.mock("@/lib/copilot-sdk-runner", () => ({ cancelSdkRun: services.cancelSdk }));
vi.mock("@/lib/work-executor", () => ({ finalizeCancelledWorkRun: services.finalize }));
vi.mock("@/lib/task-executor", () => ({ finalizeAutomationRun: services.finalize }));

import { POST } from "./route";
import { CopilotProcessStopError } from "@/lib/copilot-process";

const request = new NextRequest("http://localhost/api/runs/status-run/cancel", { method: "POST" });
const context = { params: Promise.resolve({ id: "status-run" }) };

beforeEach(() => { vi.resetAllMocks(); });

describe("Terminal versus managed cancellation", () => {
  it.each([
    ["TERMINAL_START", "PENDING"], ["TERMINAL_START", "RUNNING"],
    ["TERMINAL_RESUME", "PENDING"], ["TERMINAL_RESUME", "RUNNING"],
  ])("rejects in-app cancellation of external %s in %s state", async (trigger, status) => {
    services.query.mockResolvedValue({ id: "status-run", trigger, status });
    const response = await POST(request, context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("synchronizes its history automatically") });
    expect(services.update).not.toHaveBeenCalled();
    expect(services.cancel).not.toHaveBeenCalled();
    expect(services.cancelSdk).not.toHaveBeenCalled();
    expect(services.finalize).not.toHaveBeenCalled();
  });

  it.each(["CLI", "SDK"])("retains managed %s cancellation", async (engine) => {
    services.query.mockResolvedValue({ id: "status-run", status: "RUNNING", trigger: "WORK", engine, workId: "status-work" });
    services.cancelSdk.mockReturnValue(true);
    services.cancel.mockResolvedValue(true);
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    expect(engine === "SDK" ? services.cancelSdk : services.cancel).toHaveBeenCalledWith("status-run");
    expect(engine === "SDK" ? services.cancel : services.cancelSdk).not.toHaveBeenCalled();
  });

  it("reports failed native process termination without falsely cancelling the Run", async () => {
    services.query.mockResolvedValue({ id: "status-run", status: "RUNNING", trigger: "WORK", engine: "CLI", workId: "status-work" });
    services.cancel.mockRejectedValue(new CopilotProcessStopError(new Error("synthetic termination failure")));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request, context);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("may still be running") });
      expect(services.update).not.toHaveBeenCalled();
      expect(services.finalize).not.toHaveBeenCalled();
      expect(services.cancelSdk).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
});
