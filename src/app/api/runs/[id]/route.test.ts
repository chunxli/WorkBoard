import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  user: vi.fn(), query: vi.fn(), observe: vi.fn(), readFile: vi.fn(), log: vi.fn(), diff: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: services.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { run: { findFirst: services.query } } }));
vi.mock("@/lib/run-status", () => ({ getRunStatusSnapshot: services.observe }));
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

describe("owned metadata-only Run status API", () => {
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
