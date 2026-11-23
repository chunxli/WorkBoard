import { NextRequest } from "next/server";
import { hostname } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { caseIqStartupObservationSchema } from "@/lib/caseiq-startup";

const services = vi.hoisted(() => ({
  user: vi.fn(), query: vi.fn(), observe: vi.fn(), readFile: vi.fn(), log: vi.fn(), diff: vi.fn(), startup: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: services.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findFirst: services.query } } }));
vi.mock("@/lib/run-status", () => ({ getRunStatusSnapshot: services.observe }));
vi.mock("@/lib/caseiq-startup-state", () => ({ getCaseIqStartup: services.startup }));
vi.mock("@/lib/run-artifacts", () => ({ readRunLogTail: services.log }));
vi.mock("@/lib/git-safety", () => ({ getRunDiff: services.diff }));
vi.mock("node:fs/promises", () => ({ readFile: services.readFile }));

import { GET } from "./route";

const context = { params: Promise.resolve({ id: "status-run" }) };
const request = (view = "status") => new NextRequest(`http://localhost/api/runs/status-run?view=${view}`);
const snapshot = {
  id: "status-run", status: "RUNNING", displayStatus: "SYNCING",
  terminalActive: false, observationError: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  services.user.mockResolvedValue("status-owner");
  services.query.mockResolvedValue({ id: "status-run", status: "RUNNING", promptSnapshot: "Private prompt" });
  services.observe.mockResolvedValue(snapshot);
  services.log.mockResolvedValue("Raw log");
});

describe("owned CaseIQ current-Run startup metadata", () => {
  const at = new Date("2026-11-10T00:00:00.000Z");
  beforeEach(() => {
    services.query.mockResolvedValue({
      id: "status-run", status: "RUNNING", engine: "CASEIQ", providerId: "caseiq",
      hostname: hostname(), startedAt: at, createdAt: at,
    });
    services.startup.mockReturnValue({
      phase: "launcher", attempt: 1, startedAt: at.toISOString(), updatedAt: at.toISOString(),
      steps: [{ phase: "checking", at: at.toISOString() }, { phase: "launcher", at: at.toISOString() }],
    });
  });

  it("returns an uncached real startup snapshot without loading logs, prompts or old history", async () => {
    const response = await GET(request("startup"), context);
    const value = await response.json();
    expect(caseIqStartupObservationSchema.safeParse(value).success).toBe(true);
    expect(value).toMatchObject({ runId: "status-run", status: "RUNNING", startup: { phase: "launcher" }, unavailableReason: null });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(Object.keys(services.query.mock.calls[0][0].select).sort()).toEqual([
      "createdAt", "engine", "hostname", "id", "providerId", "startedAt", "status",
    ]);
    expect(services.startup).toHaveBeenCalledWith("status-run");
    expect(services.log).not.toHaveBeenCalled();
    expect(services.readFile).not.toHaveBeenCalled();
    expect(services.observe).not.toHaveBeenCalled();
    expect(services.diff).not.toHaveBeenCalled();
  });

  it("requires authentication and ownership before reading any coordinator evidence", async () => {
    services.user.mockResolvedValueOnce(null);
    expect((await GET(request("startup"), context)).status).toBe(401);
    expect(services.query).not.toHaveBeenCalled();
    services.query.mockResolvedValueOnce(null);
    expect((await GET(request("startup"), context)).status).toBe(404);
    expect(services.startup).not.toHaveBeenCalled();
    expect(services.query.mock.calls[0][0].where).toMatchObject({
      id: "status-run", OR: [{ task: { repo: { userId: "status-owner" } } }, { work: { userId: "status-owner" } }],
    });
  });

  it("rejects legacy CaseIQ Terminal Runs rather than attaching web startup evidence", async () => {
    services.query.mockResolvedValueOnce({ engine: "CLI", providerId: "caseiq" });
    expect((await GET(request("startup"), context)).status).toBe(400);
    expect(services.startup).not.toHaveBeenCalled();
  });

  it.each([null, "unrelated-owning-host"])("reports missing/foreign host identity %s without reading another host's state", async (host) => {
    services.query.mockResolvedValueOnce({
      id: "status-run", status: "RUNNING", engine: "CASEIQ", providerId: "caseiq",
      hostname: host, startedAt: at, createdAt: at,
    });
    const value = await (await GET(request("startup"), context)).json();
    expect(value.startup).toBeNull();
    expect(value.unavailableReason).toContain("owning host");
    expect(services.startup).not.toHaveBeenCalled();
  });

  it("does not turn coordinator loss into a false claim that a Prompt has not started", async () => {
    services.startup.mockReturnValueOnce(null);
    const value = await (await GET(request("startup"), context)).json();
    expect(value.startup).toBeNull();
    expect(value.unavailableReason).toContain("may already be executing");
  });

  it("preserves queued and terminal statuses without replaying stale startup markers", async () => {
    for (const status of ["PENDING", "FAILED", "CANCELLED", "TIMEOUT", "SUCCESS"]) {
      services.query.mockResolvedValueOnce({
        id: "status-run", status, engine: "CASEIQ", providerId: "caseiq",
        hostname: hostname(), startedAt: null, createdAt: at,
      });
      services.startup.mockReturnValueOnce(null);
      const value = await (await GET(request("startup"), context)).json();
      expect(value).toMatchObject({ status, startup: null, unavailableReason: null, startedAt: at.toISOString() });
    }
    expect(services.startup).toHaveBeenCalledTimes(1);
  });
});

describe("owned metadata-only Run status API", () => {
  it("returns measured Pending preparation through the same metadata-only response", async () => {
    const pending = {
      ...snapshot, status: "PENDING", displayStatus: "PENDING", terminalActive: null,
      preparation: { phase: "snapshot", progress: { filesScanned: 5, bytesRead: 145_000_000 } },
    };
    services.observe.mockResolvedValueOnce(pending);
    const response = await GET(request(), context);
    expect(await response.json()).toEqual(pending);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(services.log).not.toHaveBeenCalled();
    expect(services.readFile).not.toHaveBeenCalled();
  });

  it("returns uncached status without logs, prompts, or conversation history", async () => {
    const response = await GET(request(), context);
    expect(await response.json()).toEqual(snapshot);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    const query = services.query.mock.calls[0][0];
    expect(query.where).toMatchObject({
      id: "status-run", OR: [{ task: { repo: { userId: "status-owner" } } }, { work: { userId: "status-owner" } }],
    });
    expect(Object.keys(query.select).sort()).toEqual([
      "copilotSessionId", "createdAt", "hostname", "id", "resumedRuns", "status", "terminalLaunches", "trigger",
    ]);
    expect(services.observe).toHaveBeenCalledOnce();
    expect(services.readFile).not.toHaveBeenCalled();
    expect(services.log).not.toHaveBeenCalled();
    expect(services.diff).not.toHaveBeenCalled();
  });

  it("does not inspect activity before authenticating", async () => {
    services.user.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(services.query).not.toHaveBeenCalled();
    expect(services.observe).not.toHaveBeenCalled();
  });

  it("does not inspect absent or foreign Runs", async () => {
    services.query.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(services.observe).not.toHaveBeenCalled();
  });

  it("preserves the existing lightweight raw-log view", async () => {
    services.query.mockResolvedValue({ status: "RUNNING", logPath: "synthetic.log" });
    const response = await GET(request("live"), context);
    expect(await response.json()).toEqual({ status: "RUNNING", log: "Raw log" });
    expect(services.log).toHaveBeenCalledWith("synthetic.log");
    expect(services.observe).not.toHaveBeenCalled();
  });
});
