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
import WorkFileBrowser from "@/components/WorkFileBrowser";
import StatusBadge from "@/components/StatusBadge";
import CancelRunButton from "@/components/CancelRunButton";
import RunStatusRefresher from "@/components/RunStatusRefresher";
import { formatDuration } from "@/lib/format";
import RunDuration from "@/components/RunDuration";
import { discoverProjectSkills } from "@/lib/skill-discovery";
import ExperimentBuilder from "@/components/ExperimentBuilder";
import ExperimentRefresher from "@/components/ExperimentRefresher";
import { findActiveRunConflicts } from "@/lib/run-access";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { isTerminalResumeReady } from "@/lib/terminal-resume";
import { copilotSessionExists } from "@/lib/copilot-session-compat";
import { ArrowLeft, ArrowUpRight, Bot, Boxes, Clock3, Cpu, FlaskConical, FolderOpen, History, Info, ListTodo } from "lucide-react";
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
import { readInitialWorkAttachmentMetadata } from "@/lib/work-attachments";
import { MessageAttachments } from "@/components/WorkMessageAttachments";

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

  const skillComparisonSetting = process.env.WORKBOARD_SHOW_SKILL_COMPARISON?.trim().toLowerCase() ?? "";
  if (skillComparisonSetting && skillComparisonSetting !== "true" && skillComparisonSetting !== "false") {
    throw new Error("WORKBOARD_SHOW_SKILL_COMPARISON must be true or false (defaults to false).");
  }
  const showSkillComparison = skillComparisonSetting === "true" && work.status !== "ARCHIVED";

  const prompt = await readWorkPrompt(work).catch(() => ({
    content: work.promptCache,
    hash: work.promptHash ?? hashWorkContent(work.promptCache),
    modifiedAt: work.updatedAt.toISOString(),
  }));
  const initialAttachments = await readInitialWorkAttachmentMetadata(work)
    .then((files) => ({ files, error: null }))
    .catch((error: unknown) => ({
      files: [],
      error: error instanceof Error ? error.message : "Could not load initial Prompt attachments.",
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
  const projectSkills = showSkillComparison
    ? await discoverProjectSkills(work.directoryPath).catch(() => [])
    : [];
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
    <div className="work-detail-page space-y-1">
      <SessionConversation
        key={work.id}
        workId={work.id}
        runId={latestRun?.id ?? null}
        runtimeEngine={latestRun?.engine ?? null}
        initialLog={latestLog}
        isLive={latestRun?.status === "PENDING" || latestRun?.status === "RUNNING"}
        historySync={Boolean(latestRun && isTerminalRunTrigger(latestRun.trigger) && (latestRun.status === "RUNNING" || latestRun.status === "UNKNOWN"))}
        outputFormat={latestRun?.outputFormat === "json" ? "json" : "text"}
        workHeader={<>
        <div className="work-toolbar-identity flex min-w-0 items-center gap-2">
          <Link href="/work" title="Back to Work Board" aria-label="Back to Work Board" className="work-toolbar-control grid size-9 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300">
            <ArrowLeft size={15} aria-hidden="true" />
          </Link>
          <h1 title={work.name} className="min-w-0 flex-1 truncate text-sm font-bold text-white">{work.name}</h1>
          <span className="shrink-0 rounded-full border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[10px] font-semibold text-neutral-400">{work.status}</span>
        </div>
        <details key={`details:${work.id}`} className="work-toolbar-details group min-w-0 shrink-0 text-xs">
          <summary title="Work details" aria-label="Work details" className="work-toolbar-control flex size-8 cursor-pointer list-none items-center justify-center gap-1 rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 [&::-webkit-details-marker]:hidden">
            <Info size={15} aria-hidden="true" />
            <span className="sr-only group-open:not-sr-only">Work details</span>
          </summary>
          <div className="space-y-2 pt-2">
            <p className="break-words font-semibold text-neutral-200">{work.name}</p>
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
            {latestRun?.copilotSessionId && (
              <p className="break-all font-mono text-neutral-400">Session {latestRun.copilotSessionId}</p>
            )}
          </div>
        </details>
        </>}
        workActions={<WorkActions
          workId={work.id}
          name={work.name}
          directoryPath={work.directoryPath}
          archived={work.status === "ARCHIVED"}
          followUpMode={followUpParent ? "resume" : "new"}
          followUpDisabledReason={followUpDisabledReason}
          canOpenLocal={canOpenLocal}
          terminalRunId={latestRun?.id ?? null}
          terminalState={terminalState}
        />}
        notices={<>
        {startError && (
          <p role="alert" className="border border-red-800 bg-red-950/30 p-3 text-sm text-red-300">
            {startError}
          </p>
        )}
        {latestRunState && <RunStatusRefresher key={latestRunState.id} initialState={latestRunState} />}
        <ExperimentRefresher active={hasActiveExperiment} />
        {latestRunState?.displayStatus === "SYNCING" && (
          <p role="status" className="text-xs text-emerald-200">{TERMINAL_SYNCING_MESSAGE}</p>
        )}
        {latestRunState?.observationError && (
          <p role="alert" className="break-words text-sm text-red-400">{latestRunState.observationError}</p>
        )}
        </>}
          runActions={latestRun && (
            <div className="flex shrink-0 items-center gap-1">
              <StatusBadge status={latestRunState?.displayStatus ?? latestRun.status} />
              <RunDuration key={latestRun.id} startedAt={latestRun.startedAt?.toISOString() ?? null}
                finishedAt={latestRun.finishedAt?.toISOString() ?? null} status={latestRun.status}
                initialLabel={formatDuration(latestRun.startedAt, latestRun.finishedAt)}
                className="whitespace-nowrap text-[10px] text-neutral-400" />
              {canCancelRun(latestRun) && (
                <CancelRunButton runId={latestRun.id} />
              )}
              <Link href={`/runs/${latestRun.id}`} title="Full details" aria-label="Full details" className="work-toolbar-action work-toolbar-control size-8 shrink-0">
                <span className="sr-only">Full details</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </div>
          )}
        runError={latestRun?.errorMessage && (
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
        fileBrowser={<WorkFileBrowser workId={work.id} />}
        panels={[
        { id: "settings", label: "Execution settings", content: <WorkExecutionSettings
        embedded
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
      /> },
        { id: "prompt", label: "Prompt", content: <div className="space-y-3">
      {initialAttachments.error && <p role="alert" className="text-sm text-red-400">{initialAttachments.error}</p>}
      <MessageAttachments workId={work.id} files={initialAttachments.files} />
      <PromptEditor
        embedded
        key={`prompt:${work.id}`}
        workId={work.id}
        promptFileName={work.promptFileName}
        initialContent={prompt.content}
        initialHash={prompt.hash}
        defaultEngine={work.defaultEngine}
        hasActiveConflict={activeConflicts.length > 0}
        archived={work.status === "ARCHIVED"}
      /></div> },
        ...((showSkillComparison || work.experiments.length > 0) ? [{ id: "comparisons", label: "Comparisons", content: <>
      {showSkillComparison && (
        <ExperimentBuilder
          workId={work.id}
          initialSkills={projectSkills}
          defaultEngine={work.defaultEngine}
        />
      )}

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
      </> }] : []),
        { id: "history", label: "Run history", content: <section className="space-y-3">
          <SectionHeading icon={History} title="Run history">
            <span className="text-xs text-neutral-500">{Math.max(0, work.runs.length - 1)} earlier {work.runs.length === 2 ? "Run" : "Runs"}</span>
          </SectionHeading>
          {work.runs.length > 1 ? <div className="rounded-md border border-neutral-800 bg-neutral-900/40">
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
          </div> : <p className="text-sm text-neutral-400">No earlier Runs yet.</p>}
        </section> },
        ...(work.tasks.length > 0 ? [{ id: "automations", label: "Automations", content: <section>
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
        </section> }] : []),
      ]}
      />
    </div>
  );
}