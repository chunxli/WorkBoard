import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hostname } from "node:os";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { hashWorkContent, readWorkPrompt } from "@/lib/work-files";
import PromptEditor from "@/components/PromptEditor";
import WorkActions from "@/components/WorkActions";
import LiveRunLog from "@/components/LiveRunLog";
import StatusBadge from "@/components/StatusBadge";
import CancelRunButton from "@/components/CancelRunButton";
import { formatDuration } from "@/lib/format";
import { discoverProjectSkills } from "@/lib/skill-discovery";
import ExperimentBuilder from "@/components/ExperimentBuilder";
import ExperimentRefresher from "@/components/ExperimentRefresher";
import { findActiveRunConflicts } from "@/lib/run-access";
import TerminalSessionActions from "@/components/TerminalSessionActions";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { isTerminalResumeReady } from "@/lib/terminal-resume";
import { copilotSessionExists } from "@/lib/copilot-session-compat";
import { ArrowLeft, ArrowUpRight, Bot, Boxes, Clock3, Cpu, FlaskConical, FolderOpen, History, ListTodo, Radio } from "lucide-react";
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
        include: { terminalLaunches: { select: { status: true }, take: 1 } },
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
  const followUpParent = followUpParentCandidate && (
    followUpParentCandidate.hostname && followUpParentCandidate.hostname !== hostname()
      ? true
      : followUpParentCandidate.copilotSessionId &&
        await copilotSessionExists(followUpParentCandidate.copilotSessionId).catch(() => true)
  )
    ? followUpParentCandidate
    : null;
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
  const canOpenTerminal =
    localTerminalAvailable(requestHost) &&
    (!latestRun?.hostname || latestRun.hostname === hostname());
  const latestRunResumeReady = latestRun?.copilotSessionId && canOpenTerminal
    ? await isTerminalResumeReady({
        id: latestRun.id,
        taskId: latestRun.taskId,
        status: latestRun.status,
        work,
      })
    : false;
  const followUpDisabledReason =
    work.status === "ARCHIVED"
      ? "Restore this Work before following up"
      : followUpConflicts.length > 0
        ? "Wait for active Runs in this Work directory to finish"
        : followUpParent?.hostname && followUpParent.hostname !== hostname()
          ? "The latest Work session belongs to another machine"
          : null;

  return (
    <div className="space-y-8">
      <header className="flex flex-col justify-between gap-4 border-b border-neutral-800 pb-5 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <Link href="/work" className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500 hover:text-emerald-300">
            <ArrowLeft size={13} aria-hidden="true" />
            Work Board
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-white sm:text-[28px]">{work.name}</h1>
            <span className="rounded-full border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[10px] font-semibold text-neutral-400">{work.status}</span>
          </div>
          <p className="mt-2 flex min-w-0 items-center gap-2 text-xs text-neutral-500" title={work.directoryPath}>
            <FolderOpen size={13} className="shrink-0" aria-hidden="true" />
            <span className="truncate font-mono">{work.directoryPath}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <MetaChip icon={Cpu}>{work.defaultEngine}</MetaChip>
            <MetaChip icon={Bot}>{work.model ?? "Auto model"}</MetaChip>
            <MetaChip icon={Clock3}>{work.timeoutSeconds ? `${work.timeoutSeconds}s timeout` : "No timeout"}</MetaChip>
            {work.sourceRepo && <MetaChip icon={Boxes}>{work.sourceRepo.name}</MetaChip>}
          </div>
        </div>
        <WorkActions
          workId={work.id}
          directoryPath={work.directoryPath}
          archived={work.status === "ARCHIVED"}
          followUpMode={followUpParent ? "resume" : "new"}
          followUpDisabledReason={followUpDisabledReason}
        />
      </header>

      {startError && (
        <p role="alert" className="border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">
          {startError}
        </p>
      )}

      <WorkExecutionSettings
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

      {latestRun && (
        <section className="space-y-3 border-t border-neutral-800 pt-6">
          <SectionHeading icon={Radio} title="Latest run">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={latestRun.status} />
              <span className="text-xs text-neutral-500">
                {latestRun.trigger} · {latestRun.engine ?? "CLI"} · {formatDuration(latestRun.startedAt, latestRun.finishedAt)}
              </span>
              {(latestRun.status === "PENDING" || latestRun.status === "RUNNING") && (
                <CancelRunButton runId={latestRun.id} />
              )}
              {latestRun.copilotSessionId && canOpenTerminal && (
                <TerminalSessionActions
                  key={`${latestRun.id}:${latestRun.status}:${latestRun.terminalLaunches[0]?.status ?? "none"}`}
                  runId={latestRun.id}
                  canResume={
                    latestRunResumeReady &&
                    work.status !== "ARCHIVED"
                  }
                  canSync={
                    latestRun.status === "RUNNING" &&
                    isTerminalRunTrigger(latestRun.trigger) &&
                    latestRun.terminalLaunches[0] !== undefined &&
                    latestRun.terminalLaunches[0].status !== "COMPLETED"
                  }
                />
              )}
              <Link
                href={`/runs/${latestRun.id}`}
                className="ui-secondary-button min-h-8 px-3 py-1.5"
              >
                Full details
                <ArrowUpRight size={13} aria-hidden="true" />
              </Link>
            </div>
          </SectionHeading>
          <LiveRunLog
            runId={latestRun.id}
            initialLog={latestLog}
            isLive={latestRun.status === "PENDING" || latestRun.status === "RUNNING"}
            outputFormat={latestRun.outputFormat === "json" ? "json" : "text"}
          />
          {latestRun.errorMessage && (
            <p role="alert" className="rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2 text-sm text-red-400">
              {latestRun.errorMessage}
            </p>
          )}
          {latestRun.finalOutput && latestRun.status !== "RUNNING" && (
            <div className="border-l-2 border-emerald-600 pl-4">
              <h3 className="mb-2 text-sm font-semibold text-neutral-300">Result</h3>
              <MarkdownResult content={latestRun.finalOutput} />
            </div>
          )}
        </section>
      )}

      {work.runs.length > 1 && (
        <section>
          <SectionHeading icon={History} title="Run history" />
          <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40">
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
        </section>
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