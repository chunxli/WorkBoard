import { hostname } from "node:os";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  query: vi.fn(), update: vi.fn(), cancel: vi.fn(), cancelSdk: vi.fn(), finalize: vi.fn(),
  nativeActive: vi.fn(), requestInterrupted: vi.fn(), cancelPendingCaseIq: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "status-owner" }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findFirst: services.query, update: services.update } } }));
vi.mock("@/lib/copilot-runner", () => ({ cancelRun: services.cancel, isNativeCopilotRunActive: services.nativeActive }));
vi.mock("@/lib/caseiq-run-lifecycle", () => ({ requestInterruptedCaseIqCancellation: services.requestInterrupted }));
vi.mock("@/lib/copilot-sdk-runner", () => ({ cancelSdkRun: services.cancelSdk }));
vi.mock("@/lib/work-executor", () => ({
  cancelPendingCaseIqWorkRun: services.cancelPendingCaseIq, finalizeCancelledWorkRun: services.finalize,
}));
vi.mock("@/lib/task-executor", () => ({ finalizeAutomationRun: services.finalize }));

import { POST } from "./route";
import { CopilotProcessStopError } from "@/lib/copilot-process";
import { CaseIqIntegrationError, CaseIqRunUnconfirmedError } from "@/lib/caseiq-errors";

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

  it("requests cooperative cancellation of an interrupted CaseIQ Run without releasing it", async () => {
    const run = { id: "status-run", status: "RUNNING", hostname: hostname(), trigger: "WORK", engine: "CASEIQ", providerId: "caseiq" };
    services.query.mockResolvedValue(run);
    const response = await POST(request, context);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, pending: true });
    expect(services.requestInterrupted).toHaveBeenCalledExactlyOnceWith(run);
    expect(services.cancel).not.toHaveBeenCalled();
    expect(services.update).not.toHaveBeenCalled();
    expect(services.finalize).not.toHaveBeenCalled();
  });

  it("uses atomic cancellation for a pending CaseIQ Work Run", async () => {
    services.query.mockResolvedValue({ id: "status-run", status: "PENDING", trigger: "FOLLOW_UP", engine: "CASEIQ", providerId: "caseiq", workId: "status-work" });
    services.cancelPendingCaseIq.mockResolvedValue(true);
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    expect(services.cancelPendingCaseIq).toHaveBeenCalledExactlyOnceWith("status-run", "Run was cancelled before it started.");
    expect(services.finalize).not.toHaveBeenCalled();
    expect(services.requestInterrupted).not.toHaveBeenCalled();
  });

  it("requests a running stop if the CaseIQ execution claim wins the pending cancellation race", async () => {
    const running = { id: "status-run", status: "RUNNING", hostname: hostname(), trigger: "FOLLOW_UP", engine: "CASEIQ", providerId: "caseiq", workId: "status-work" };
    services.query.mockResolvedValueOnce({ ...running, status: "PENDING" }).mockResolvedValueOnce(running);
    services.cancelPendingCaseIq.mockResolvedValue(false);
    const response = await POST(request, context);
    expect(response.status).toBe(202);
    expect(services.requestInterrupted).toHaveBeenCalledExactlyOnceWith(running);
    expect(services.finalize).not.toHaveBeenCalled();
  });

  it("acknowledges a live CaseIQ cancellation without claiming the Run is finalized", async () => {
    services.query.mockResolvedValue({
      id: "status-run", status: "RUNNING", hostname: hostname(), trigger: "WORK", engine: "CASEIQ", providerId: "caseiq",
    });
    services.nativeActive.mockReturnValue(true);
    services.cancel.mockResolvedValue(true);
    const response = await POST(request, context);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, pending: true });
    expect(services.requestInterrupted).not.toHaveBeenCalled();
    expect(services.update).not.toHaveBeenCalled();
    expect(services.finalize).not.toHaveBeenCalled();
  });

  it("reports an unconfirmed live CaseIQ stop without changing or releasing the Run", async () => {
    services.query.mockResolvedValue({
      id: "status-run", status: "RUNNING", hostname: hostname(), trigger: "WORK", engine: "CASEIQ", providerId: "caseiq",
    });
    services.nativeActive.mockReturnValue(true);
    services.cancel.mockRejectedValue(new CaseIqRunUnconfirmedError());
    const response = await POST(request, context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("This Work remains reserved") });
    expect(services.requestInterrupted).not.toHaveBeenCalled();
    expect(services.update).not.toHaveBeenCalled();
    expect(services.finalize).not.toHaveBeenCalled();
  });

  it("reports incomplete CaseIQ recovery metadata instead of pretending cancellation succeeded", async () => {
    services.query.mockResolvedValue({
      id: "status-run", status: "RUNNING", hostname: hostname(), trigger: "FOLLOW_UP", engine: "CASEIQ", providerId: "caseiq",
    });
    services.requestInterrupted.mockRejectedValue(new CaseIqIntegrationError("Missing CaseIQ launch records.", 409));
    const response = await POST(request, context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Missing CaseIQ launch records." });
    expect(services.update).not.toHaveBeenCalled();
    expect(services.finalize).not.toHaveBeenCalled();
  });
});
