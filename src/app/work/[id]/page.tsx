import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hostname } from "node:os";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { hashWorkContent, readWorkPrompt } from "@/lib/work-files";
import PromptEditor from "@/components/PromptEditor";
import WorkActions from "@/components/WorkActions";
import SessionConversation from "@/components/SessionConversation";
import StatusBadge from "@/components/StatusBadge";
import CancelRunButton from "@/components/CancelRunButton";
import RunStatusRefresher from "@/components/RunStatusRefresher";
import { formatDuration } from "@/lib/format";
import { discoverProjectSkills } from "@/lib/skill-discovery";
import ExperimentBuilder from "@/components/ExperimentBuilder";
import ExperimentRefresher from "@/components/ExperimentRefresher";
import { findActiveRunConflicts } from "@/lib/run-access";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { isTerminalResumeReady } from "@/lib/terminal-resume";
import { copilotSessionExists } from "@/lib/copilot-session-compat";
import { ArrowLeft, ArrowUpRight, Bot, Boxes, ChevronDown, Clock3, Cpu, FlaskConical, FolderOpen, History, Info, ListTodo, Radio } from "lucide-react";
import WorkExecutionSettings from "@/components/WorkExecutionSettings";
import MetaChip from "@/components/MetaChip";
import SectionHeading from "@/components/SectionHeading";
import MarkdownResult from "@/components/MarkdownResult";
import type {
  WorkContextTier,
  WorkReasoningEffort,
} from "@/components/WorkExecutionFields";
import { readRunLogTail } from "@/lib/run-artifacts";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { canCancelRun, getRunStatusMessage, TERMINAL_SYNCING_MESSAGE } from "@/lib/work-run-status";
import { getRunStatusSnapshot } from "@/lib/run-status";

export default async function WorkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ startError?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const { id } = await params;
  const { startError } = await searchParams;
  const work = await prisma.work.findFirst({
    where: { id, userId },
    include: {
      sourceRepo: { select: { id: true, name: true } },
      tasks: { orderBy: { updatedAt: "desc" }, select: { id: true, name: true, triggerType: true } },
      runs: {
        where: { experimentVariantId: null },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          terminalLaunches: { select: { id: true, status: true, errorMessage: true }, take: 1 },
          resumedRuns: { select: { id: true }, take: 1 },
        },
      },
      experiments: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          variants: {
            orderBy: { createdAt: "asc" },
            include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
          },
        },
      },
    },
  });
  if (!work) notFound();

  const prompt = await readWorkPrompt(work).catch(() => ({
    content: work.promptCache,
    hash: work.promptHash ?? hashWorkContent(work.promptCache),
    modifiedAt: work.updatedAt.toISOString(),
  }));
  const latestRun = work.runs[0];
  const latestRunState = latestRun ? await getRunStatusSnapshot(latestRun) : null;
  const settlingRun = latestRunState?.displayStatus === "SYNCING" ? latestRun : null;
  const followUpParentCandidate = await prisma.run.findFirst({
    where: {
      workId: work.id,
      experimentVariantId: null,
      copilotSessionId: { not: null },
      status: { notIn: ["PENDING", "RUNNING"] },
      startedAt: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, hostname: true, copilotSessionId: true, executionPath: true },
  });
  const followUpParent = settlingRun ?? (followUpParentCandidate && (
    followUpParentCandidate.hostname && followUpParentCandidate.hostname !== hostname()
      ? true
      : followUpParentCandidate.copilotSessionId &&
        await copilotSessionExists(followUpParentCandidate.copilotSessionId).catch(() => true)
  )
    ? followUpParentCandidate
    : null);
  const latestLog = latestRun?.logPath
    ? await readRunLogTail(latestRun.logPath).catch(() => "")
    : "";
  const activeConflicts = await findActiveRunConflicts(userId, work.directoryPath);
  const followUpDirectory = followUpParent?.executionPath ?? work.directoryPath;
  const followUpConflicts = followUpDirectory === work.directoryPath
    ? activeConflicts
    : await findActiveRunConflicts(userId, followUpDirectory);
  const projectSkills = await discoverProjectSkills(work.directoryPath).catch(() => []);
  const hasActiveExperiment = work.experiments.some((experiment) =>
    ["PROVISIONING", "RUNNING"].includes(experiment.status)
  );
  const requestHost = (await headers()).get("host") ?? "";
  const canOpenLocal = localTerminalAvailable(requestHost) && (!work.hostname || work.hostname === hostname());
  const canOpenTerminal =
    canOpenLocal &&
    (!latestRun?.hostname || latestRun.hostname === hostname());
  let terminalState: "ready" | "active" | "unavailable" = "unavailable";
  if (latestRun?.copilotSessionId && canOpenTerminal && work.status !== "ARCHIVED") {
    if (isTerminalRunTrigger(latestRun.trigger) && (latestRun.status === "RUNNING" || latestRun.status === "PENDING")) {
      if (latestRunState?.terminalActive === true) terminalState = "active";
      else if (latestRunState?.terminalActive === false) terminalState = "ready";
    } else if (await isTerminalResumeReady({ id: latestRun.id, taskId: latestRun.taskId, status: latestRun.status, work })) {
      terminalState = "ready";
    }
  }
  const followUpDisabledReason =
    work.status === "ARCHIVED"
      ? "Restore this Work before following up"
      : followUpConflicts.some((run) => run.id !== settlingRun?.id)
        ? "Wait for active Runs in this Work directory to finish"
        : followUpParent?.hostname && followUpParent.hostname !== hostname()
          ? "The latest Work session belongs to another machine"
          : null;

  return (
    <div className="space-y-5">
      <header className="space-y-2 border-b border-neutral-800 pb-3">
        <div className="flex min-w-0 flex-col justify-between gap-2 lg:flex-row lg:items-start">
          <div className="min-w-0">
            <Link href="/work" className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500 hover:text-emerald-300">
              <ArrowLeft size={13} aria-hidden="true" />
              Work Board
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 max-w-full break-words text-xl font-bold text-white sm:text-2xl">{work.name}</h1>
              <span className="rounded-full border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[10px] font-semibold text-neutral-400">{work.status}</span>
            </div>
          </div>
          <WorkActions
            workId={work.id}
            name={work.name}
            directoryPath={work.directoryPath}
            archived={work.status === "ARCHIVED"}
            followUpMode={followUpParent ? "resume" : "new"}
            followUpDisabledReason={followUpDisabledReason}
            canOpenLocal={canOpenLocal}
            terminalRunId={latestRun?.id ?? null}
            terminalState={terminalState}
          />
        </div>
        <details key={`details:${work.id}`} className="group min-w-0 text-xs">
          <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-2 text-neutral-400 hover:text-neutral-200 [&::-webkit-details-marker]:hidden">
            <Info size={13} aria-hidden="true" />
            Work details
            <ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="space-y-2 pt-2">
            <p className="flex min-w-0 items-start gap-2 text-neutral-400">
              <FolderOpen size={13} className="mt-1 shrink-0" aria-hidden="true" />
              <span className="break-all font-mono leading-5">{work.directoryPath}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <MetaChip icon={Cpu}>Default {work.defaultEngine}</MetaChip>
              <MetaChip icon={Bot}>{work.model ?? "Auto model"}</MetaChip>
              <MetaChip icon={Clock3}>{work.timeoutSeconds ? `${work.timeoutSeconds}s timeout` : "No timeout"}</MetaChip>
              {work.sourceRepo && <MetaChip icon={Boxes}>{work.sourceRepo.name}</MetaChip>}
            </div>
            {latestRun && (
              <p className="text-neutral-500">Latest Run: {latestRun.trigger} · {latestRun.engine ?? "CLI"}</p>
            )}
          </div>
        </details>
      </header>

      {startError && (
        <p role="alert" className="border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">
          {startError}
        </p>
      )}

      <section className="space-y-2">
        <SectionHeading icon={Radio} title="Session conversation">
          {latestRun && (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={latestRunState?.displayStatus ?? latestRun.status} />
              <span className="text-xs text-neutral-500">
                {formatDuration(latestRun.startedAt, latestRun.finishedAt)}
              </span>
              {canCancelRun(latestRun) && (
                <CancelRunButton runId={latestRun.id} />
              )}
              <Link
                href={`/runs/${latestRun.id}`}
                className="ui-secondary-button min-h-8 px-3 py-1.5"
              >
                Full details
                <ArrowUpRight size={13} aria-hidden="true" />
              </Link>
            </div>
          )}
        </SectionHeading>
        {latestRunState && <RunStatusRefresher key={latestRunState.id} initialState={latestRunState} />}
        {latestRunState?.displayStatus === "SYNCING" && (
          <p role="status" className="text-xs text-emerald-200">{TERMINAL_SYNCING_MESSAGE}</p>
        )}
        {latestRunState?.observationError && (
          <p role="alert" className="break-words text-sm text-red-400">{latestRunState.observationError}</p>
        )}
        <SessionConversation
          key={work.id}
          workId={work.id}
          runId={latestRun?.id ?? null}
          initialLog={latestLog}
          isLive={latestRun?.status === "PENDING" || latestRun?.status === "RUNNING"}
          historySync={Boolean(latestRun && isTerminalRunTrigger(latestRun.trigger) && (latestRun.status === "RUNNING" || latestRun.status === "UNKNOWN"))}
          outputFormat={latestRun?.outputFormat === "json" ? "json" : "text"}
        />
        {latestRun?.errorMessage && (
          <p
            role={latestRun.status === "UNKNOWN" ? "status" : "alert"}
            className={`rounded-md border px-3 py-2 text-sm ${
              latestRun.status === "UNKNOWN"
                ? "border-emerald-700/60 bg-emerald-900/40 text-emerald-200"
                : "border-red-900/50 bg-red-950/20 text-red-400"
            }`}
          >
            {getRunStatusMessage(latestRun.status, latestRun.errorMessage)}
          </p>
        )}
      </section>

      <WorkExecutionSettings
        key={`settings:${work.id}`}
        workId={work.id}
        initialValue={{
          defaultEngine: work.defaultEngine,
          agent: work.agent ?? "",
          model: work.model ?? "",
          fallbackModel: work.fallbackModel ?? "",
          contextTier: (work.contextTier ?? "") as WorkContextTier,
          reasoningEffort: (work.reasoningEffort ?? "") as WorkReasoningEffort,
          permissionMode: work.permissionMode === "full" ? "full" : "default",
          outputFormat: work.outputFormat === "json" ? "json" : "text",
          timeoutSeconds: work.timeoutSeconds,
        }}
      />

      <PromptEditor
        key={`prompt:${work.id}`}
        workId={work.id}
        promptFileName={work.promptFileName}
        initialContent={prompt.content}
        initialHash={prompt.hash}
        defaultEngine={work.defaultEngine}
        hasActiveConflict={activeConflicts.length > 0}
        archived={work.status === "ARCHIVED"}
      />

      {work.status !== "ARCHIVED" && (
        <ExperimentBuilder
          workId={work.id}
          initialSkills={projectSkills}
          defaultEngine={work.defaultEngine}
        />
      )}

      <ExperimentRefresher active={hasActiveExperiment} />
      {work.experiments.map((experiment) => (
        <section key={experiment.id} className="space-y-3 border-t border-neutral-800 pt-6">
          <SectionHeading icon={FlaskConical} title={experiment.name}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] text-neutral-500">
                {experiment.invocationMode} · {experiment.engine} · {new Date(experiment.createdAt).toLocaleString()}
              </span>
              <span className="rounded-full border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[10px] text-neutral-400">
                {experiment.status}
              </span>
            </div>
          </SectionHeading>
          {experiment.errorMessage && <p className="text-sm text-red-400">{experiment.errorMessage}</p>}
          <div className="grid gap-3 lg:grid-cols-2">
            {experiment.variants.map((variant) => {
              const variantRun = variant.runs[0];
              return (
                <div key={variant.id} className="ui-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium">{variant.skillName ?? "No Skill baseline"}</h3>
                      <p className="mt-1 text-xs text-neutral-500">
                        Skill invoked: {variant.skillInvoked === null ? "Unknown" : variant.skillInvoked ? "Yes" : "No"}
                      </p>
                    </div>
                    <StatusBadge status={variant.status} />
                  </div>
                  {variant.skillHash && (
                    <p className="mt-2 font-mono text-[10px] text-neutral-600">{variant.skillHash}</p>
                  )}
                  {variantRun?.finalOutput && (
                    <div className="mt-3 max-h-48 overflow-y-auto border-l-2 border-neutral-700 pl-3">
                      <MarkdownResult content={variantRun.finalOutput} compact />
                    </div>
                  )}
                  {variantRun && (
                    <Link
                      href={`/runs/${variantRun.id}`}
                      className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300"
                    >
                      Open run and artifacts
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </Link>
                  )}
                  {variant.errorMessage && <p className="mt-2 text-xs text-red-400">{variant.errorMessage}</p>}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {work.runs.length > 1 && (
        <details key={`history:${work.id}`} className="ui-panel group min-w-0 overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <History size={15} className="shrink-0 text-neutral-500" aria-hidden="true" />
            <h2 className="text-sm font-bold">Run history</h2>
            <span className="text-xs text-neutral-500">{work.runs.length - 1} earlier {work.runs.length === 2 ? "Run" : "Runs"}</span>
            <ChevronDown size={15} className="ml-auto shrink-0 text-neutral-500 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="border-t border-neutral-800 bg-neutral-900/40">
            {work.runs.slice(1).map((run) => (
              <Link
                key={run.id}
                href={`/runs/${run.id}`}
                className="grid gap-2 border-t border-neutral-800 px-4 py-3 first:border-0 hover:bg-neutral-800/40 sm:grid-cols-[1fr_auto_auto]"
              >
                <span className="font-mono text-sm">{run.id.slice(0, 8)}</span>
                <StatusBadge status={run.status} />
                <span className="text-xs text-neutral-500">
                  {run.trigger} · {new Date(run.createdAt).toLocaleString()}
                </span>
              </Link>
            ))}
          </div>
        </details>
      )}

      {work.tasks.length > 0 && (
        <section>
          <SectionHeading icon={ListTodo} title="Automations" />
          <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40">
            {work.tasks.map((task) => (
              <Link
                key={task.id}
                href={`/tasks/${task.id}`}
                className="flex items-center justify-between border-t border-neutral-800 px-4 py-3 first:border-0 hover:bg-neutral-800/40"
              >
                <span>{task.name}</span>
                <span className="text-xs text-neutral-500">{task.triggerType}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}