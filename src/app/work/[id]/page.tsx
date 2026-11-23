import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hostname } from "node:os";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { QUEUED_FOLLOW_UP_MODE } from "@/lib/work-run-queue";
import { getSessionUserId } from "@/lib/session";
import { hashWorkContent, readWorkPrompt } from "@/lib/work-files";
import PromptEditor from "@/components/PromptEditor";
import WorkActions from "@/components/WorkActions";
import SessionConversation from "@/components/SessionConversation";
import WorkFileBrowser from "@/components/WorkFileBrowser";
import StatusBadge from "@/components/StatusBadge";
import CaseIqRuntimeTag from "@/components/CaseIqRuntimeTag";
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
import CaseIqWorkPanel from "@/components/CaseIqWorkPanel";
import CaseIqMcpConfiguration from "@/components/CaseIqMcpConfiguration";
import { isCaseIqRuntime, runtimeProviderLabel, webFollowUpBlockedReason } from "@/lib/runtime-provider";
import { pairedLaneInfo, pairedOutputFolder, pairedSessionId, pairedWorkLanes, type PairedWorkLane } from "@/lib/work-session-pair";
import { assertPairedRunArtifactLocation, pairedWorkspacePath } from "@/lib/work-pair-directories";

const workRunRelations = {
  terminalLaunches: { select: { id: true, status: true, errorMessage: true }, take: 1 },
  resumedRuns: { select: { id: true }, take: 1 },
} satisfies Prisma.RunInclude;

type DisplayRun = Prisma.RunGetPayload<{ include: typeof workRunRelations }>;

async function pairedLaneDisplay(work: { id: string; directoryPath: string }, pair: { cliSessionId: string; caseIqSessionId: string }, lane: PairedWorkLane) {
  const sessionId = pairedSessionId(pair, lane);
  const executionPath = pairedWorkspacePath(work.directoryPath, pair, lane);
  const where: Prisma.RunWhereInput = {
    workId: work.id, copilotSessionId: sessionId, engine: lane, providerId: lane === "CASEIQ" ? "caseiq" : null,
    taskId: null, experimentVariantId: null, executionPath, trigger: { in: ["WORK", "FOLLOW_UP"] },
  };
  const active = await prisma.run.findMany({
    where: { ...where, status: { in: ["PENDING", "RUNNING"] } },
    orderBy: [{ status: "desc" }, { createdAt: "asc" }, { id: "asc" }], take: 1, include: workRunRelations,
  });
  const run = active[0] ?? await prisma.run.findFirst({
    where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: workRunRelations,
  });
  const state = run ? await getRunStatusSnapshot(run) : null;
  let initialLog = "";
  let artifactError = false;
  if (run?.logPath) {
    try {
      await assertPairedRunArtifactLocation({ ...work, sessionPair: pair }, run);
      initialLog = await readRunLogTail(run.logPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.error("[Work Board] Could not read the initial paired Run log.", error);
        artifactError = true;
      }
    }
  }
  return {
    sessionId, runId: run?.id ?? null,
    initialLog,
    isLive: run?.status === "PENDING" || run?.status === "RUNNING",
    awaitingRunStart: state?.displayStatus === "PENDING",
    outputFormat: run?.outputFormat === "json" ? "json" as const : "text" as const,
    notices: <>{state && <RunStatusRefresher key={state.id} initialState={state} />}
      {artifactError && <p role="alert" className="text-xs text-red-400">The original Run log could not be verified or read.</p>}
    </>,
    runActions: run && renderRunActions(run, state, true),
    runError: run && renderRunError(run),
  };
}

function renderRunActions(run: DisplayRun, state: Awaited<ReturnType<typeof getRunStatusSnapshot>> | null, paired = false) {
  return <div className={paired ? "work-paired-run-actions" : "work-toolbar-run flex min-w-0 flex-wrap items-center gap-1"}
    role={paired ? undefined : "group"} aria-label={paired ? undefined : "Run controls"}>
    {!paired && isCaseIqRuntime(run) && <CaseIqRuntimeTag title={`Runtime: ${runtimeProviderLabel(run)}`} />}
    <StatusBadge status={state?.displayStatus ?? run.status} />
    {state?.displayStatus !== "SYNCING" && (!paired || run.startedAt) && <RunDuration key={run.id} startedAt={run.startedAt?.toISOString() ?? null}
      finishedAt={run.finishedAt?.toISOString() ?? null} status={run.status}
      initialLabel={formatDuration(run.startedAt, run.finishedAt)} className="whitespace-nowrap text-[10px] text-neutral-400" />}
    {canCancelRun(run) && <CancelRunButton runId={run.id} compact={paired} />}
    <Link href={`/runs/${run.id}`} title="Full details" aria-label="Full details" className="work-toolbar-action work-toolbar-control size-8 shrink-0">
      <ArrowUpRight size={14} aria-hidden="true" />
    </Link>
  </div>;
}

function renderRunError(run: DisplayRun) {
  return run.errorMessage && <p role={run.status === "UNKNOWN" ? "status" : "alert"} className={`rounded-md border px-3 py-2 text-sm ${
    run.status === "UNKNOWN" ? "border-emerald-700/60 bg-emerald-900/40 text-emerald-200"
      : "border-red-900/50 bg-red-950/20 text-red-400"}`}>
    {getRunStatusMessage(run.status, run.errorMessage)}
  </p>;
}

export default async function WorkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ startError?: string; panel?: string; sessionId?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const { id } = await params;
  const { startError, panel, sessionId } = await searchParams;
  const work = await prisma.work.findFirst({
    where: { id, userId },
    include: {
      sessionPair: true,
      sourceRepo: { select: { id: true, name: true } },
      tasks: { orderBy: { updatedAt: "desc" }, select: { id: true, name: true, triggerType: true } },
      runs: {
        where: { experimentVariantId: null },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: workRunRelations,
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
  const pair = work.sessionPair;
  const laneDisplays = pair ? await Promise.all(pairedWorkLanes.map((lane) => pairedLaneDisplay(work, pair, lane))) : null;

  const skillComparisonSetting = process.env.WORKBOARD_SHOW_SKILL_COMPARISON?.trim().toLowerCase() ?? "";
  if (skillComparisonSetting && skillComparisonSetting !== "true" && skillComparisonSetting !== "false") {
    throw new Error("WORKBOARD_SHOW_SKILL_COMPARISON must be true or false (defaults to false).");
  }
  const showSkillComparison = skillComparisonSetting === "true" && work.status !== "ARCHIVED" && !pair;

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
  const queuedFollowUp = !pair && await prisma.run.findFirst({
    where: { workId: work.id, concurrencyMode: QUEUED_FOLLOW_UP_MODE, status: "PENDING", experimentVariantId: null },
    select: { id: true },
  });
  const queueHead = queuedFollowUp ? await prisma.run.findFirst({
    where: { workId: work.id, experimentVariantId: null, OR: [
      { status: "RUNNING" },
      { status: "PENDING", OR: [
        { resumedFromRunId: null },
        { resumedFromRun: { is: { status: { notIn: ["PENDING", "RUNNING"] } } } },
      ] },
    ] },
    orderBy: [{ status: "desc" }, { createdAt: "asc" }],
    include: workRunRelations,
  }) : null;
  const latestRun = pair ? null : queueHead ?? work.runs[0];
  const latestRunState = latestRun ? await getRunStatusSnapshot(latestRun) : null;
  const settlingRun = latestRunState?.displayStatus === "SYNCING" ? latestRun : null;
  const followUpParentCandidate = !pair && await prisma.run.findFirst({
    where: {
      workId: work.id,
      experimentVariantId: null,
      copilotSessionId: { not: null },
      status: { notIn: ["PENDING", "RUNNING"] },
      startedAt: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, hostname: true, copilotSessionId: true, executionPath: true, providerId: true, engine: true },
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
    !pair && canOpenLocal &&
    work.defaultEngine !== "CASEIQ" && latestRun?.engine !== "CASEIQ" &&
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
      : followUpParent && webFollowUpBlockedReason(followUpParent)
        ? webFollowUpBlockedReason(followUpParent)
      : followUpConflicts.some((run) => run.id !== settlingRun?.id)
        ? "Wait for active Runs in this Work directory to finish"
        : followUpParent?.hostname && followUpParent.hostname !== hostname()
          ? "The latest Work session belongs to another machine"
          : null;

  return (
    <div className="work-detail-page space-y-1">
      <SessionConversation
        key={work.id}
        paired={laneDisplays && pair ? { lanes: { CLI: laneDisplays[0], CASEIQ: laneDisplays[1] },
          sendBlockedReason: work.status === "ARCHIVED" ? "Restore this Work before sending."
            : !canOpenLocal || work.hostname !== hostname() ? "Open this Work on its local Windows host to send." : null } : undefined}
        workId={work.id}
        runId={latestRun?.id ?? null}
        runtimeEngine={latestRun?.engine ?? null}
        initialLog={latestLog}
        isLive={latestRun?.status === "PENDING" || latestRun?.status === "RUNNING"}
        awaitingRunStart={latestRunState?.displayStatus === "PENDING"}
        historySync={Boolean(latestRun && isTerminalRunTrigger(latestRun.trigger) && (latestRun.status === "RUNNING" || latestRun.status === "UNKNOWN"))}
        outputFormat={latestRun?.outputFormat === "json" ? "json" : "text"}
        workHeader={<div className="work-toolbar-identity flex min-w-0 items-center gap-2">
          <Link href="/work" title="Back to Work Board" aria-label="Back to Work Board" className="work-toolbar-control grid size-9 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300">
            <ArrowLeft size={15} aria-hidden="true" />
          </Link>
          <h1 title={work.name} className="min-w-0 truncate text-sm font-bold text-white">{work.name}</h1>
          <span className="shrink-0 rounded-full border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[10px] font-semibold text-neutral-400">{work.status}</span>
          <details key={`details:${work.id}`} name="work-toolbar-panels" className="work-toolbar-details min-w-0 shrink-0 text-xs">
            <summary title="Work details" aria-label="Work details" className="work-toolbar-control flex size-8 cursor-pointer list-none items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 [&::-webkit-details-marker]:hidden">
              <Info size={15} aria-hidden="true" />
            </summary>
            <div className="work-toolbar-details-panel space-y-2">
              <p className="break-words font-semibold text-neutral-200">{work.name}</p>
              <p className="flex min-w-0 items-start gap-2 text-neutral-400">
                <FolderOpen size={13} className="mt-1 shrink-0" aria-hidden="true" />
                <span className="break-all font-mono leading-5">{work.directoryPath}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <MetaChip icon={Cpu}>{pair ? `${pairedLaneInfo.CLI.label} + ${pairedLaneInfo.CASEIQ.label}` : `Default ${work.defaultEngine}`}</MetaChip>
                <MetaChip icon={Bot}>{work.model ?? "Auto model"}</MetaChip>
                <MetaChip icon={Clock3}>{work.timeoutSeconds ? `${work.timeoutSeconds}s timeout` : "No timeout"}</MetaChip>
                {work.sourceRepo && <MetaChip icon={Boxes}>{work.sourceRepo.name}</MetaChip>}
              </div>
              {latestRun && (
                <p className="text-neutral-500">{queuedFollowUp ? "Current Run" : "Latest Run"}: {latestRun.trigger} · {runtimeProviderLabel(latestRun)}</p>
              )}
              {latestRun?.copilotSessionId && (
                <p className="break-all font-mono text-neutral-400">Session {latestRun.copilotSessionId}</p>
              )}
            </div>
          </details>
        </div>}
        workActions={<WorkActions
          workId={work.id}
          name={work.name}
          directoryPath={work.directoryPath}
          archived={work.status === "ARCHIVED"}
          paired={Boolean(pair)}
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
        runActions={latestRun && renderRunActions(latestRun, latestRunState)}
        runError={latestRun && renderRunError(latestRun)}
        fileBrowser={<WorkFileBrowser workId={work.id} pairedOutputRoot={pair ? pairedOutputFolder(pair) : undefined} />}
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
        ...(pair || work.defaultEngine === "CASEIQ" || work.runs.some((run) => run.providerId === "caseiq") || panel === "mcp" ? [{
          id: "mcp", label: "MCP configuration", content: <CaseIqMcpConfiguration workId={work.id}
            initialSessionId={pair?.caseIqSessionId ?? sessionId ?? work.runs.find((run) => run.engine === "CASEIQ" && run.providerId === "caseiq")?.copilotSessionId ?? null} />,
        }] : []),
        ...(work.runs.some((run) => run.providerId === "caseiq" && run.engine !== "CASEIQ") ? [{
          id: "caseiq", label: "CaseIQ Terminal (legacy)", content: <CaseIqWorkPanel workId={work.id}
          disabledReason={work.status === "ARCHIVED" ? "Restore this Work before opening CaseIQ."
            : !canOpenLocal ? "Open this Work on its Windows host."
              : activeConflicts.length ? "Wait for the active Run to finish before starting a new CaseIQ session." : null} />,
        }] : []),
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
        paired={Boolean(pair)}
        canStartPair={!pair && canOpenLocal && work.hostname === hostname() && work.runs.length === 0 && work.tasks.length === 0}
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
            <span className="text-xs text-neutral-500">{Math.max(0, work.runs.length - (pair ? 0 : 1))} {pair ? "loaded Runs" : `earlier ${work.runs.length === 2 ? "Run" : "Runs"}`}</span>
          </SectionHeading>
          {work.runs.length > (pair ? 0 : 1) ? <div className="rounded-md border border-neutral-800 bg-neutral-900/40">
            {work.runs.slice(pair ? 0 : 1).map((run) => (
              <Link
                key={run.id}
                href={`/runs/${run.id}`}
                className="grid gap-2 border-t border-neutral-800 px-4 py-3 first:border-0 hover:bg-neutral-800/40 sm:grid-cols-[1fr_auto_auto]"
              >
                <span className="font-mono text-sm">{run.id.slice(0, 8)}</span>
                <span className="flex items-center gap-2">
                  {isCaseIqRuntime(run) && <CaseIqRuntimeTag title={`Runtime: ${runtimeProviderLabel(run)}`} />}
                  <StatusBadge status={run.status} />
                </span>
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