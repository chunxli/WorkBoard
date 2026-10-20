import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo, Run, Task, Work } from "@/generated/prisma/client";
import WorkDetailPage from "./work/[id]/page";
import RunDetailPage from "./runs/[id]/page";

const { workQuery, runQuery, terminalActivity } = vi.hoisted(() => ({
  workQuery: vi.fn(),
  runQuery: vi.fn(),
  terminalActivity: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3100" }),
}));
vi.mock("node:os", () => ({ hostname: () => "layout-host" }));
vi.mock("@/lib/prisma", () => ({
  prisma: { work: { findFirst: workQuery }, run: { findFirst: runQuery } },
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: async () => "layout-user" }));
vi.mock("@/lib/auth-mode", () => ({ authMode: "local" }));
vi.mock("@/lib/work-files", () => ({
  readWorkPrompt: async () => ({ content: "Synthetic prompt", hash: "fixture-hash" }),
  hashWorkContent: () => "fixture-hash",
}));
vi.mock("@/lib/skill-discovery", () => ({ discoverProjectSkills: async () => [] }));
vi.mock("@/lib/run-access", () => ({
  findActiveRunConflicts: async () => [],
  ownedRunWhere: () => ({}),
}));
vi.mock("@/lib/local-terminal-policy", () => ({ localTerminalAvailable: () => true }));
vi.mock("@/lib/terminal-resume", () => ({
  isTerminalResumeReady: async () => true,
  getTerminalSessionActivity: terminalActivity,
}));
vi.mock("@/lib/copilot-session-compat", () => ({ copilotSessionExists: async () => true }));
vi.mock("@/lib/run-artifacts", () => ({
  readRunLogTail: async () => "Synthetic output",
  readRunDiffPreview: async () => "",
}));
vi.mock("@/lib/git-safety", () => ({
  getRunDiff: async () => "",
  getRemoteUrl: async () => "https://example.invalid/layout.git",
}));
vi.mock("@/lib/copilot-runner", () => ({ getRunProcessStats: () => undefined }));
vi.mock("@/lib/repo-workdir", () => ({ getRepoWorkdirPath: () => "C:\\layout\\automation" }));
vi.mock("@/components/ExperimentBuilder", () => ({ default: () => null }));
vi.mock("@/components/ExperimentRefresher", () => ({ default: () => null }));

const now = new Date("2026-05-20T12:00:00Z");

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    id: "layout-work", userId: "layout-user", sourceRepoId: "layout-repo",
    name: "Conversation layout", directoryPath: "C:\\layout\\work",
    canonicalPath: "c:\\layout\\work", promptFileName: "PROMPT.md",
    promptCache: "Synthetic prompt", promptHash: "fixture-hash", hostname: "layout-host",
    status: "ACTIVE", defaultEngine: "CLI", agent: null, model: "default-model",
    fallbackModel: null, contextTier: null, reasoningEffort: null,
    permissionMode: "default", outputFormat: "text", timeoutSeconds: 1800,
    position: 0, archivedAt: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "latest01-layout-run", workId: "layout-work", taskId: null,
    experimentVariantId: null, status: "SUCCESS", trigger: "FOLLOW_UP", engine: "SDK",
    executionPath: null, promptSnapshot: "Synthetic prompt", finalOutput: "Synthetic result",
    outputDir: "C:\\layout\\artifacts", copilotSessionId: "layout-session",
    concurrencyMode: null, resumedFromRunId: null, branchName: "layout-branch",
    baseCommit: "1111111122222222", finalCommit: "3333333344444444",
    logPath: "C:\\layout\\stdout.log", outputFormat: "text", agent: null,
    model: "frozen-run-model", fallbackModel: null, contextTier: null,
    reasoningEffort: null, permissionMode: "default", timeoutSeconds: 1800,
    exitCode: 0, errorMessage: null, startedAt: now,
    finishedAt: new Date(now.getTime() + 60_000), createdAt: now,
    pid: null, command: "copilot --synthetic-layout-fixture",
    cpuTimeMs: 1500, peakMemoryMb: 64, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, modelsUsed: null,
    notificationClaimedAt: null, notificationSentAt: null,
    notificationSuppressedAt: now, notificationError: null, hostname: "layout-host",
    ...overrides,
  };
}

function makeRepo(): Repo {
  return {
    id: "layout-repo", userId: "layout-user", name: "Layout resource",
    sourceType: "LOCAL_PATH", location: "C:\\layout\\automation",
    defaultBranch: "main", hostname: "layout-host", createdAt: now, updatedAt: now,
  };
}

function makeTask(): Task {
  return {
    id: "layout-task", name: "Layout automation", repoId: "layout-repo", workId: null,
    prompt: "Synthetic automation prompt", agent: null, model: "task-model",
    fallbackModel: null, contextTier: null, reasoningEffort: null,
    permissionMode: "default", outputFormat: "text", triggerType: "MANUAL",
    cronExpression: null, webhookEvents: null, enabled: false, useSafeBranch: true,
    waitForPreviousRuns: false, timeoutSeconds: 1800, archivedAt: null,
    createdAt: now, updatedAt: now,
  };
}

function makeWorkPage(runs: Run[] = [makeRun()], overrides: Partial<Work> = {}) {
  return {
    ...makeWork(overrides), sourceRepo: makeRepo(), tasks: [], experiments: [],
    runs: runs.map((run) => ({ ...run, terminalLaunches: [] })),
  };
}

type RelatedRun = Pick<Run, "id" | "trigger" | "status">;
type RunPageFixture = Run & {
  work: Work | null;
  task: (Task & { repo: Repo }) | null;
  resumedFromRun: RelatedRun | null;
  resumedRuns: RelatedRun[];
  terminalLaunches: { id: string; status: string }[];
};

function makeRunPage(overrides: Partial<Run> = {}): RunPageFixture {
  return {
    ...makeRun(overrides), work: makeWork(), task: null,
    resumedFromRun: null, resumedRuns: [], terminalLaunches: [],
  };
}

async function renderWork(work = makeWorkPage(), startError?: string) {
  workQuery.mockResolvedValue(work);
  runQuery.mockResolvedValue(null);
  return renderToStaticMarkup(await WorkDetailPage({
    params: Promise.resolve({ id: work.id }),
    searchParams: Promise.resolve({ startError }),
  }));
}

async function renderRun(run = makeRunPage()) {
  runQuery.mockResolvedValue(run);
  return renderToStaticMarkup(await RunDetailPage({ params: Promise.resolve({ id: run.id }) }));
}

function disclosure(markup: string, title: string) {
  const section = [...markup.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)]
    .map((match) => match[0])
    .find((details) => details.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1].includes(title));
  expect(section, `${title} disclosure`).toBeDefined();
  if (!section) throw new Error(`Missing ${title} disclosure`);
  expect(section).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  return section;
}

function header(markup: string) {
  return markup.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1] ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  terminalActivity.mockResolvedValue({ active: false, starting: false });
});

describe("compact Work details", () => {
  it("collapses secondary context while keeping the conversation first and actions available", async () => {
    const markup = await renderWork();
    const details = disclosure(markup, "Work details");
    for (const value of ["C:\\layout\\work", "Default ", "CLI", "default-model", "1800s timeout", "Layout resource", "FOLLOW_UP", "SDK"]) {
      expect(details).toContain(value);
    }
    for (const action of ["Follow Up", "Copy path", "Open Conversation layout in Windows Explorer",
      "Open Conversation layout in VS Code", "Archive Conversation layout"]) {
      expect(header(markup)).toContain(action);
      expect(details).not.toContain(action);
    }
    expect(markup.indexOf("Session conversation")).toBeLessThan(markup.indexOf("Execution settings"));
    expect(markup.indexOf("Session conversation")).toBeLessThan(markup.indexOf("Synthetic prompt"));
    expect(markup).toContain("Full details");
    expect(disclosure(markup, "Execution settings")).toContain("<form");
    expect(disclosure(markup, "Prompt")).toContain("<textarea");
  });

  it.each([2, 3, 20])("collapses the %i loaded Runs into a counted, linked history", async (count) => {
    const runs = Array.from({ length: count }, (_, index) => makeRun({ id: `run-${index}` }));
    const markup = await renderWork(makeWorkPage(runs));
    const history = disclosure(markup, "Run history");
    expect(history).toContain(`${count - 1} earlier ${count === 2 ? "Run" : "Runs"}`);
    expect(history).not.toContain('href="/runs/run-0"');
    for (let index = 1; index < count; index++) {
      expect(history).toContain(`href="/runs/run-${index}"`);
    }
    expect(workQuery).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        runs: expect.objectContaining({ take: 20, orderBy: { createdAt: "desc" } }),
      }),
    }));
  });

  it.each([0, 1])("omits empty history with %i loaded Runs", async (count) => {
    const markup = await renderWork(makeWorkPage(Array.from({ length: count }, () => makeRun())));
    expect(markup).not.toContain("Run history");
    expect(markup).toContain("Session conversation");
  });

  it("keeps cancellation and failures outside collapsed information", async () => {
    const running = await renderWork(makeWorkPage([makeRun({ status: "RUNNING", finishedAt: null })]));
    expect(running.replace(/<details\b[\s\S]*?<\/details>/g, "")).toContain("Cancel");
    const failed = await renderWork(
      makeWorkPage([makeRun({ status: "FAILED", errorMessage: "Synthetic execution failed" })]),
      "Synthetic start failed",
    );
    const visible = failed.replace(/<details\b[\s\S]*?<\/details>/g, "");
    expect(visible).toContain("Synthetic execution failed");
    expect(visible).toContain("Synthetic start failed");
  });

  it("retains archived and external-Terminal safeguards", async () => {
    const archived = await renderWork(makeWorkPage([makeRun()], { status: "ARCHIVED", archivedAt: now }));
    expect(header(archived)).toContain("Restore Conversation layout");
    expect(archived).toContain("Restore this Work before following up");
    terminalActivity.mockResolvedValue({ active: true, starting: false });
    const terminal = await renderWork(makeWorkPage([makeRun({
      status: "RUNNING", trigger: "TERMINAL_RESUME", finishedAt: null,
    })]));
    expect(header(terminal)).toContain("Check and resume Conversation layout in Windows Terminal");
    expect(terminalActivity).toHaveBeenCalledWith("layout-session", null, now);
    expect(terminal).toContain("Session conversation");
  });
});

describe("output-first Run details", () => {
  it("shows Result and Output before closed diagnostics without dropping metadata or artifacts", async () => {
    const run = makeRunPage();
    run.resumedFromRun = { id: "previous-layout-run", trigger: "WORK", status: "SUCCESS" };
    run.resumedRuns = [{ id: "next-layout-run", trigger: "FOLLOW_UP", status: "SUCCESS" }];
    const markup = await renderRun(run);
    const details = disclosure(markup, "Run details");
    expect(markup.indexOf(">Result<")).toBeLessThan(markup.indexOf(">Output<"));
    expect(markup.indexOf(">Output<")).toBeLessThan(markup.indexOf(">Run details<"));
    expect(markup.indexOf(">Output<")).toBeLessThan(markup.indexOf(">Artifacts<"));
    for (const value of ["FOLLOW_UP", "layout-branch", "layout-host", "11111111", "33333333",
      "C:\\layout\\work", "previous-layout-run", "next-layout-run", "Process info",
      "frozen-run-model", "copilot --synthetic-layout-fixture"]) {
      expect(details).toContain(value);
    }
    expect(header(markup)).toContain("Elapsed time");
    expect(header(markup)).not.toContain("layout-branch");
    for (const name of ["result.md", "transcript.jsonl", "diff.patch", "run.json", "stdout.log", "stderr.log"]) {
      expect(markup).toContain(`/api/runs/${run.id}/artifacts/${name}`);
    }
  });

  it("keeps live cancellation, continuation and errors visible", async () => {
    const running = await renderRun(makeRunPage({ status: "RUNNING", finishedAt: null, finalOutput: null }));
    expect(header(running)).toContain("Cancel");
    expect(running).not.toContain(">Result<");
    expect(running).toContain(">Output<");
    const run = makeRunPage({ status: "FAILED", errorMessage: "Synthetic execution failed" });
    run.resumedRuns = [{ id: "active-layout-run", status: "RUNNING", trigger: "FOLLOW_UP" }];
    const failed = header(await renderRun(run));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Synthetic execution failed");
    expect(failed).toContain('href="/runs/active-layout-run"');
  });

  it("retains legacy Automation repository and process context inside Run details", async () => {
    const run = makeRunPage({ workId: null, taskId: "layout-task", model: null });
    run.work = null;
    run.task = { ...makeTask(), repo: makeRepo() };
    const markup = await renderRun(run);
    const details = disclosure(markup, "Run details");
    expect(header(markup)).toContain('href="/tasks/layout-task"');
    expect(header(markup)).toContain("Layout automation");
    expect(details).toContain("C:\\layout\\automation");
    expect(details).toContain("https://example.invalid/layout.git");
    expect(details).toContain("task-model");
  });
});

describe("Terminal activity presentation", () => {
  it.each(["active", "stopped"])("uses physical %s state instead of a RUNNING badge in Work and Run details", async (state) => {
    terminalActivity.mockResolvedValue({ active: state === "active", starting: false });
    const overrides: Partial<Run> = {
      status: "RUNNING", trigger: "TERMINAL_RESUME", finishedAt: null,
    };
    const work = await renderWork(makeWorkPage([makeRun(overrides)]));
    const run = await renderRun(makeRunPage(overrides));
    for (const markup of [work, run]) {
      expect(markup).toContain(`aria-label="${state === "active" ? "IN TERMINAL" : "SYNCING"}"`);
      expect(markup).not.toContain('aria-label="RUNNING"');
      expect(markup).not.toContain("Cancel run");
      if (state === "stopped") {
        expect(markup).toContain("Terminal stopped. Synchronizing session history.");
        expect(markup.match(/<span[^>]*aria-label="SYNCING"[^>]*>/)?.[0]).toContain("text-emerald-200");
        expect(header(markup)).toContain("Resume Conversation layout in Windows Terminal");
      }
    }
  });

  it("keeps activity-check failures visible without enabling Terminal continuation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    terminalActivity.mockRejectedValue(new Error("Lock access denied"));
    try {
      const overrides: Partial<Run> = { status: "RUNNING", trigger: "TERMINAL_RESUME", finishedAt: null };
      for (const markup of [
        await renderWork(makeWorkPage([makeRun(overrides)])),
        await renderRun(makeRunPage(overrides)),
      ]) {
        expect(markup).toContain("Unable to check Terminal activity: Lock access denied");
        expect(markup).not.toContain('aria-label="SYNCING"');
        expect(header(markup)).not.toContain("Resume Conversation layout in Windows Terminal");
      }
    } finally {
      log.mockRestore();
    }
  });
});
