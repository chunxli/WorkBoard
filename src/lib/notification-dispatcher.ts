import { prisma } from "@/lib/prisma";
import { formatDuration, formatTokenCount } from "@/lib/format";
import {
  sendSystemNotification,
  compactNotificationText,
  type SystemNotification,
  type SystemNotifier,
} from "@/lib/system-notifier";

const TERMINAL_RUN_STATUSES = ["SUCCESS", "FAILED", "TIMED_OUT", "CANCELLED"] as const;
const NOTIFICATION_INTERVAL_MS = 5_000;
const BATCH_SIZE = 100;

type RunNotificationStatus = "SUCCESS" | "FAILED" | "TIMED_OUT";
type NotificationOutcome = "sent" | "suppressed" | "error";

export interface RunNotificationCandidate {
  id: string;
  status: string;
  trigger: string;
  startedAt: Date | null;
  finishedAt: Date;
  experimentVariantId: string | null;
  model: string | null;
  modelsUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  work: { id: string; userId: string; name: string } | null;
  task: { name: string; workId: string | null; repo: { userId: string } } | null;
}

export interface ExperimentNotificationCandidate {
  id: string;
  name: string;
  status: string;
  finishedAt: Date;
  errorMessage: string | null;
  work: { id: string; userId: string };
  variants: Array<{
    runs: Array<{ status: string }>;
  }>;
}

export interface NotificationDispatcherDependencies {
  now: () => Date;
  notify: SystemNotifier;
  listRunCandidates: () => Promise<RunNotificationCandidate[]>;
  claimRun: (id: string, claimedAt: Date) => Promise<boolean>;
  completeRun: (
    id: string,
    outcome: NotificationOutcome,
    completedAt: Date,
    errorMessage?: string
  ) => Promise<void>;
  listExperimentCandidates: () => Promise<ExperimentNotificationCandidate[]>;
  claimExperiment: (id: string, claimedAt: Date) => Promise<boolean>;
  completeExperiment: (
    id: string,
    outcome: NotificationOutcome,
    completedAt: Date,
    errorMessage?: string
  ) => Promise<void>;
  notificationsEnabled: (userId: string) => Promise<boolean>;
}

function parseModels(modelsUsed: string | null, fallback: string | null): string[] {
  try {
    const parsed = modelsUsed ? JSON.parse(modelsUsed) : [];
    if (Array.isArray(parsed)) {
      const models = [...new Set(parsed.filter((model): model is string => typeof model === "string")
        .map((model) => model.trim()).filter(Boolean))];
      if (models.length > 0) return models;
    }
  } catch {
    // Fall back to the frozen primary model for malformed legacy data.
  }
  return fallback?.trim() ? [fallback.trim()] : [];
}

function statusLabel(status: RunNotificationStatus): string {
  if (status === "SUCCESS") return "completed";
  if (status === "TIMED_OUT") return "timed out";
  return "failed";
}

export function buildRunSystemNotification(
  run: RunNotificationCandidate
): { notification: SystemNotification; userId: string } | null {
  if (!TERMINAL_RUN_STATUSES.includes(run.status as typeof TERMINAL_RUN_STATUSES[number])) {
    return null;
  }
  if (run.status === "CANCELLED" || run.experimentVariantId || run.trigger === "EXPERIMENT") {
    return null;
  }

  const owner = run.task
    ? { kind: "Automation", name: run.task.name, userId: run.task.repo.userId }
    : run.work
      ? { kind: "Work", name: run.work.name, userId: run.work.userId }
      : null;
  if (!owner) return null;

  const status = run.status as RunNotificationStatus;
  const details = run.startedAt ? [formatDuration(run.startedAt, run.finishedAt)] : [];
  const models = parseModels(run.modelsUsed, run.model);
  if (models.length > 0) {
    details.push(`${compactNotificationText(models[0], 40)}${models.length > 1 ? ` +${models.length - 1}` : ""}`);
  }
  if (run.inputTokens !== null || run.outputTokens !== null) {
    details.push(`${formatTokenCount((run.inputTokens ?? 0) + (run.outputTokens ?? 0))} tokens`);
  }
  const workId = run.task ? run.task.workId : run.work?.id;
  return {
    userId: owner.userId,
    notification: {
      title: `${owner.kind} ${statusLabel(status)}`,
      message: compactNotificationText(owner.name, 100),
      details: compactNotificationText(details.join(" · "), 100),
      destination: workId ? { kind: "work", id: workId } : { kind: "run", id: run.id },
    },
  };
}

export function resolveExperimentNotificationStatus(
  experiment: ExperimentNotificationCandidate
): RunNotificationStatus | "SUPPRESSED" | null {
  if (experiment.status === "FAILED") return "FAILED";
  if (experiment.status !== "COMPLETED" || experiment.variants.length === 0) return null;

  const statuses = experiment.variants.map((variant) => variant.runs[0]?.status ?? null);
  if (statuses.some((status) => status === null || status === "PENDING" || status === "RUNNING")) {
    return null;
  }
  if (statuses.includes("FAILED")) return "FAILED";
  if (statuses.includes("TIMED_OUT")) return "TIMED_OUT";
  if (statuses.every((status) => status === "SUCCESS")) return "SUCCESS";
  return "SUPPRESSED";
}

export function buildExperimentSystemNotification(
  experiment: ExperimentNotificationCandidate,
  status: RunNotificationStatus
): SystemNotification {
  return {
    title: `Experiment ${statusLabel(status)}`,
    message: compactNotificationText(experiment.name, 100),
    details: `${experiment.variants.length} variants`,
    destination: { kind: "work", id: experiment.work.id },
  };
}

async function processRunCandidate(
  run: RunNotificationCandidate,
  dependencies: NotificationDispatcherDependencies
): Promise<void> {
  const prepared = buildRunSystemNotification(run);
  const claimedAt = dependencies.now();
  if (!(await dependencies.claimRun(run.id, claimedAt))) return;

  if (!prepared) {
    await dependencies.completeRun(run.id, "suppressed", dependencies.now());
    return;
  }
  try {
    if (!(await dependencies.notificationsEnabled(prepared.userId))) {
      await dependencies.completeRun(run.id, "suppressed", dependencies.now());
      return;
    }
    await dependencies.notify(prepared.notification);
    await dependencies.completeRun(run.id, "sent", dependencies.now());
  } catch (error) {
    await dependencies.completeRun(
      run.id,
      "error",
      dependencies.now(),
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function processExperimentCandidate(
  experiment: ExperimentNotificationCandidate,
  dependencies: NotificationDispatcherDependencies
): Promise<void> {
  const status = resolveExperimentNotificationStatus(experiment);
  if (status === null) return;
  if (!(await dependencies.claimExperiment(experiment.id, dependencies.now()))) return;

  if (status === "SUPPRESSED") {
    await dependencies.completeExperiment(experiment.id, "suppressed", dependencies.now());
    return;
  }
  try {
    if (!(await dependencies.notificationsEnabled(experiment.work.userId))) {
      await dependencies.completeExperiment(experiment.id, "suppressed", dependencies.now());
      return;
    }
    await dependencies.notify(buildExperimentSystemNotification(experiment, status));
    await dependencies.completeExperiment(experiment.id, "sent", dependencies.now());
  } catch (error) {
    await dependencies.completeExperiment(
      experiment.id,
      "error",
      dependencies.now(),
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function dispatchPendingSystemNotifications(
  dependencies: NotificationDispatcherDependencies = prismaNotificationDependencies
): Promise<void> {
  const [runs, experiments] = await Promise.all([
    dependencies.listRunCandidates(),
    dependencies.listExperimentCandidates(),
  ]);
  await Promise.all([
    ...runs.map((run) => processRunCandidate(run, dependencies)),
    ...experiments.map((experiment) => processExperimentCandidate(experiment, dependencies)),
  ]);
}

async function completeNotification(
  target: "run" | "experiment",
  id: string,
  outcome: NotificationOutcome,
  completedAt: Date,
  errorMessage?: string
): Promise<void> {
  const data = outcome === "sent"
    ? { notificationSentAt: completedAt, notificationError: null }
    : outcome === "suppressed"
      ? { notificationSuppressedAt: completedAt, notificationError: null }
      : { notificationError: (errorMessage ?? "System notification failed").slice(0, 2_000) };
  if (target === "run") {
    await prisma.run.update({ where: { id }, data });
  } else {
    await prisma.experiment.update({ where: { id }, data });
  }
}

const prismaNotificationDependencies: NotificationDispatcherDependencies = {
  now: () => new Date(),
  notify: sendSystemNotification,
  listRunCandidates: () => prisma.run.findMany({
    where: {
      notificationClaimedAt: null,
      finishedAt: { not: null },
      status: { in: [...TERMINAL_RUN_STATUSES] },
    },
    orderBy: { finishedAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      status: true,
      trigger: true,
      startedAt: true,
      finishedAt: true,
      experimentVariantId: true,
      model: true,
      modelsUsed: true,
      inputTokens: true,
      outputTokens: true,
      work: { select: { id: true, userId: true, name: true } },
      task: { select: { name: true, workId: true, repo: { select: { userId: true } } } },
    },
  }) as Promise<RunNotificationCandidate[]>,
  claimRun: async (id, claimedAt) => (await prisma.run.updateMany({
    where: { id, notificationClaimedAt: null },
    data: { notificationClaimedAt: claimedAt },
  })).count === 1,
  completeRun: (id, outcome, completedAt, errorMessage) =>
    completeNotification("run", id, outcome, completedAt, errorMessage),
  listExperimentCandidates: () => prisma.experiment.findMany({
    where: {
      notificationClaimedAt: null,
      finishedAt: { not: null },
      status: { in: ["COMPLETED", "FAILED"] },
    },
    orderBy: { finishedAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      name: true,
      status: true,
      finishedAt: true,
      errorMessage: true,
      work: { select: { id: true, userId: true } },
      variants: {
        select: {
          runs: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { status: true },
          },
        },
      },
    },
  }) as Promise<ExperimentNotificationCandidate[]>,
  claimExperiment: async (id, claimedAt) => (await prisma.experiment.updateMany({
    where: { id, notificationClaimedAt: null },
    data: { notificationClaimedAt: claimedAt },
  })).count === 1,
  completeExperiment: (id, outcome, completedAt, errorMessage) =>
    completeNotification("experiment", id, outcome, completedAt, errorMessage),
  notificationsEnabled: async (userId) => {
    const settings = await prisma.userExecutionSettings.findUnique({
      where: { userId },
      select: { systemNotificationsEnabled: true },
    });
    return settings?.systemNotificationsEnabled ?? true;
  },
};

const globalForNotifications = globalThis as unknown as {
  systemNotificationTimer?: NodeJS.Timeout;
  systemNotificationDispatch?: Promise<void>;
};

export function startSystemNotificationDispatcher(): void {
  if (globalForNotifications.systemNotificationTimer) return;
  const tick = () => {
    if (globalForNotifications.systemNotificationDispatch) return;
    const pending = dispatchPendingSystemNotifications()
      .catch((error) => {
        console.error("[notifications] dispatch failed:", error);
      })
      .finally(() => {
        if (globalForNotifications.systemNotificationDispatch === pending) {
          delete globalForNotifications.systemNotificationDispatch;
        }
      });
    globalForNotifications.systemNotificationDispatch = pending;
  };
  const timer = setInterval(tick, NOTIFICATION_INTERVAL_MS);
  timer.unref();
  globalForNotifications.systemNotificationTimer = timer;
}
