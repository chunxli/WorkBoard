import os from "node:os";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  works: vi.fn(), activity: vi.fn(), board: vi.fn(() => null), user: vi.fn(), reconcile: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("Redirected to sign-in"); }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3100" }) }));
vi.mock("@/lib/session", () => ({ getSessionUserId: services.user }));
vi.mock("@/lib/work-directory-reconciler", () => ({ reconcileMissingWorkDirectories: services.reconcile }));
vi.mock("@/lib/auth-mode", () => ({ authMode: "local" }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  work: { findMany: services.works }, repo: { findMany: async () => [] },
  workPathShortcut: { findMany: async () => [] }, task: { count: async () => 0 },
} }));
vi.mock("@/lib/terminal-resume", () => ({
  getTerminalSessionActivity: services.activity, isTerminalResumeReady: async () => true,
}));
vi.mock("@/lib/local-terminal-policy", () => ({ localTerminalAvailable: () => true }));
vi.mock("@/lib/user-execution-defaults", () => ({ getUserExecutionDefaults: async () => ({}) }));
vi.mock("@/components/LegacyMigrationPanel", () => ({ default: () => null }));
vi.mock("@/components/WorkBoard", () => ({ default: services.board }));

import WorkBoardPage from "./page";

const now = new Date();
const run = {
  id: "status-run", taskId: null, status: "RUNNING", trigger: "TERMINAL_RESUME",
  copilotSessionId: "status-session", hostname: os.hostname(), createdAt: now,
  terminalLaunches: [], resumedRuns: [], modelsUsed: null, model: null,
  inputTokens: null, outputTokens: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  services.user.mockResolvedValue("status-owner");
  services.works.mockResolvedValue([{
    id: "status-work", name: "Status Work", directoryPath: "C:\\status\\work", promptFileName: "PROMPT.md",
    status: "ACTIVE", defaultEngine: "CLI", updatedAt: now, _count: { tasks: 0 }, runs: [run],
  }]);
  services.activity.mockResolvedValue({ active: false, starting: false });
});

describe("Work Card status summary", () => {
  it("reconciles the owner's missing roots before reading the current and archived card list", async () => {
    renderToStaticMarkup(await WorkBoardPage());
    expect(services.reconcile).toHaveBeenCalledWith("status-owner");
    expect(services.reconcile.mock.invocationCallOrder[0]).toBeLessThan(services.works.mock.invocationCallOrder[0]);
    expect(services.works).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "status-owner" } }));
  });

  it("does not inspect or change Works before authentication", async () => {
    services.user.mockResolvedValue(null);
    await expect(WorkBoardPage()).rejects.toThrow("Redirected to sign-in");
    expect(services.reconcile).not.toHaveBeenCalled();
    expect(services.works).not.toHaveBeenCalled();
  });

  it.each([
    { active: false, starting: false, status: "SYNCING", action: "ready" },
    { active: true, starting: false, status: "IN_TERMINAL", action: "active" },
    { active: false, starting: true, status: "IN_TERMINAL", action: "active" },
  ])("uses the shared $status presentation with $action actions", async (state) => {
    services.activity.mockResolvedValue(state);
    renderToStaticMarkup(await WorkBoardPage());
    expect(services.board).toHaveBeenCalledWith(expect.objectContaining({
      works: [expect.objectContaining({
        latestRunStatus: state.status, terminalResumeState: state.action, latestRunStatusError: null,
      })],
    }), undefined);
  });

  it("surfaces observation failures instead of unlocking a possibly active session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    services.activity.mockRejectedValue(new Error("Lock access denied"));
    try {
      renderToStaticMarkup(await WorkBoardPage());
      expect(services.board).toHaveBeenCalledWith(expect.objectContaining({
        works: [expect.objectContaining({
          latestRunStatus: "IN_TERMINAL", terminalResumeState: "unavailable",
          latestRunStatusError: "Unable to check Terminal activity: Lock access denied",
        })],
      }), undefined);
    } finally {
      log.mockRestore();
    }
  });
});
