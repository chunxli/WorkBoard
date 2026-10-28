import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import path from "node:path";
import { hostname } from "node:os";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getSessionUserId } from "@/lib/session";
import { getRunDiff, getRemoteUrl } from "@/lib/git-safety";
import { getRunProcessStats } from "@/lib/copilot-runner";
import { getRepoWorkdirPath } from "@/lib/repo-workdir";
import { formatDuration } from "@/lib/format";
import RunDuration from "@/components/RunDuration";
import StatusBadge from "@/components/StatusBadge";
import LiveRunLog from "@/components/LiveRunLog";
import CancelRunButton from "@/components/CancelRunButton";
import RunStatusRefresher from "@/components/RunStatusRefresher";
import ProcessInfoPanel from "@/components/ProcessInfoPanel";
import RepoInfoPanel from "@/components/RepoInfoPanel";
import DiffView from "@/components/DiffView";
import { ownedRunWhere } from "@/lib/run-access";
import WorkQuickActions from "@/components/WorkQuickActions";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { isTerminalResumeReady } from "@/lib/terminal-resume";
import { readRunDiffPreview, readRunLogTail } from "@/lib/run-artifacts";
import MetaChip from "@/components/MetaChip";
import SectionHeading from "@/components/SectionHeading";
import MarkdownResult from "@/components/MarkdownResult";
import { ArrowLeft, ArrowUpRight, ChevronDown, Clock3, Download, FileText, GitBranch, GitCompareArrows, GitCommitHorizontal, Info, Monitor, PackageOpen, TerminalSquare, Zap } from "lucide-react";
import { isTerminalRunTrigger } from "@/lib/terminal-run";
import { canCancelRun, getRunStatusMessage, TERMINAL_SYNCING_MESSAGE } from "@/lib/work-run-status";
import { getRunStatusSnapshot } from "@/lib/run-status";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/api/auth/signin");

  const { id } = await params;
  const run = await prisma.run.findFirst({
    where: ownedRunWhere(userId, id),
    include: {
      task: { include: { repo: true } },
      work: true,
      resumedFromRun: { select: { id: true, trigger: true, status: true } },
      resumedRuns: {
        orderBy: { createdAt: "desc" },
        select: { id: true, trigger: true, status: true },
      },
      terminalLaunches: { select: { id: true, status: true, errorMessage: true }, take: 1 },
    },
  });
  if (!run) notFound();
  const runState = await getRunStatusSnapshot(run);
  const activeContinuation = run.resumedRuns.find((child) => child.status === "RUNNING" || child.status === "PENDING");
  const statusMessage = getRunStatusMessage(run.status, run.errorMessage);

  const log = run.logPath ? await readRunLogTail(run.logPath).catch(() => "") : "";

  const diff = run.outputDir
    ? await readRunDiffPreview(path.join(run.outputDir, "diff.patch")).catch(() => "")
    : await getRunDiff(run);

  const workdirPath =
    run.executionPath ?? run.work?.directoryPath ?? (run.task ? getRepoWorkdirPath(run.task.repo) : "");
  const remoteUrl = workdirPath ? await getRemoteUrl(workdirPath) : null;

  const isLive = run.status === "PENDING" || run.status === "RUNNING";
  const liveProcess = isLive ? getRunProcessStats(run.id) : undefined;
  const requestHost = (await headers()).get("host") ?? "";
  const sameMachine = !run.hostname || run.hostname === hostname();
  const ownerArchived = run.work?.status === "ARCHIVED" || Boolean(run.task?.archivedAt);
  const canOpenTerminal = localTerminalAvailable(requestHost) && sameMachine;
  const resumeReady =
    Boolean(run.copilotSessionId) &&
    canOpenTerminal &&
    await isTerminalResumeReady({
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      work: run.work,
    });
  let terminalState: "ready" | "active" | "unavailable" = !ownerArchived && !activeContinuation && resumeReady ? "ready" : "unavailable";
  if (!ownerArchived && !activeContinuation && canOpenTerminal && run.copilotSessionId && isLive && isTerminalRunTrigger(run.trigger)) {
    terminalState = runState.terminalActive === null ? "unavailable" : runState.terminalActive ? "active" : "ready";
  }
  const commitRange =
    run.baseCommit && run.finalCommit
      ? `${run.baseCommit.slice(0, 8)}..${run.finalCommit.slice(0, 8)}`
      : null;

  return (
    <div className="space-y-5">
      <header className="border-b border-neutral-800 pb-3">
        <Link
          href={run.task ? `/tasks/${run.task.id}` : run.work ? `/work/${run.work.id}` : "/runs"}
          className="inline-flex max-w-full items-start gap-1.5 text-xs font-semibold text-neutral-500 hover:text-emerald-300"
        >
          <ArrowLeft size={13} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{run.task?.name ?? run.work?.name ?? "Runs"}</span>
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-white sm:text-2xl">Run <span className="font-mono">{run.id.slice(0, 8)}</span></h1>
            <StatusBadge status={runState.displayStatus} />
            {run.startedAt && (
              <span className="inline-flex items-center gap-1.5 text-xs text-neutral-500" aria-label="Elapsed time">
                <Clock3 size={13} aria-hidden="true" />
                <RunDuration key={run.id} startedAt={run.startedAt.toISOString()}
                  finishedAt={run.finishedAt?.toISOString() ?? null} status={run.status}
                  initialLabel={formatDuration(run.startedAt, run.finishedAt)} />
              </span>
            )}
            {canCancelRun(run) && <CancelRunButton runId={run.id} />}
          </div>
          <RunStatusRefresher initialState={runState} />
          {runState.displayStatus === "SYNCING" && (
            <p role="status" className="mt-2 text-xs text-emerald-200">{TERMINAL_SYNCING_MESSAGE}</p>
          )}
          {runState.observationError && (
            <p role="alert" className="mt-2 break-words text-sm text-red-400">{runState.observationError}</p>
          )}
          <WorkQuickActions
            name={run.work?.name ?? run.task?.name ?? `Run ${run.id.slice(0, 8)}`}
            directoryPath={workdirPath}
            canOpenLocal={canOpenTerminal}
            terminalRunId={run.id}
            terminalState={terminalState}
            archiveTarget={run.work ? { kind: "work", id: run.work.id } : run.task ? { kind: "task", id: run.task.id } : null}
            archived={run.work ? run.work.status === "ARCHIVED" : Boolean(run.task?.archivedAt)}
          />
        </div>
        {activeContinuation && (
          <div className="mt-2">
            <Link href={`/runs/${activeContinuation.id}`} className="ui-primary-button">
              Open active Run {activeContinuation.id.slice(0, 8)}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </div>
        )}
        {statusMessage && (
          <p role={run.status === "UNKNOWN" ? "status" : "alert"} className={`mt-2 break-words text-sm ${run.status === "UNKNOWN" ? "text-emerald-200" : "text-red-400"}`}>
            {statusMessage}
          </p>
        )}
      </header>

      {run.finalOutput && !isLive && (
        <section className="border-l-2 border-emerald-600 pl-4">
          <SectionHeading icon={FileText} title="Result" />
          <MarkdownResult content={run.finalOutput} />
        </section>
      )}

      <section>
        <SectionHeading icon={TerminalSquare} title="Output" />
        <LiveRunLog
          key={run.id}
          runId={run.id}
          initialLog={log}
          isLive={isLive}
          refreshOnStatusChange={false}
          historySync={!run.resumedRuns.length && isTerminalRunTrigger(run.trigger) && (run.status === "RUNNING" || run.status === "UNKNOWN")}
          outputFormat={(run.outputFormat ?? run.task?.outputFormat ?? "text") === "json" ? "json" : "text"}
        />
      </section>

      <details key={`details:${run.id}`} className="ui-panel group min-w-0 overflow-hidden">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <Info size={15} className="shrink-0 text-neutral-500" aria-hidden="true" />
          <h2 className="text-sm font-bold">Run details</h2>
          <ChevronDown size={15} className="ml-auto shrink-0 text-neutral-500 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-4 border-t border-neutral-800 p-4">
          <div className="flex flex-wrap gap-2">
            <MetaChip icon={Zap}>{run.trigger}</MetaChip>
            {run.branchName && <MetaChip icon={GitBranch} mono>{run.branchName}</MetaChip>}
            {(run.hostname ?? run.task?.repo.hostname) && (
              <MetaChip icon={Monitor} mono>{run.hostname ?? run.task?.repo.hostname}</MetaChip>
            )}
            {run.baseCommit && (
              <MetaChip icon={GitCommitHorizontal} mono>
                {run.baseCommit.slice(0, 8)}{run.finalCommit ? `..${run.finalCommit.slice(0, 8)}` : ""}
              </MetaChip>
            )}
          </div>
          {(run.resumedFromRun || run.resumedRuns.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {run.resumedFromRun && (
                <Link
                  href={`/runs/${run.resumedFromRun.id}`}
                  className="rounded-md border border-neutral-800 bg-neutral-950/40 px-2.5 py-1.5 font-mono text-neutral-400 hover:border-neutral-700 hover:text-emerald-300"
                >
                  Previous {run.resumedFromRun.id.slice(0, 8)} · {run.resumedFromRun.trigger}
                </Link>
              )}
              {run.resumedRuns.map((child) => (
                <Link
                  key={child.id}
                  href={`/runs/${child.id}`}
                  className="rounded-md border border-neutral-800 bg-neutral-950/40 px-2.5 py-1.5 font-mono text-neutral-400 hover:border-neutral-700 hover:text-emerald-300"
                >
                  Next {child.id.slice(0, 8)} · {child.trigger}
                </Link>
              ))}
            </div>
          )}
          {run.task ? (
            <RepoInfoPanel
              info={{
                currentBranch: run.branchName ?? run.task.repo.defaultBranch,
                defaultBranch: run.task.repo.defaultBranch,
                remoteUrl,
                workdirPath,
              }}
            />
          ) : (
            <div className="ui-panel p-4">
              <div className="text-sm text-neutral-500">Work directory</div>
              <div className="mt-1 break-all font-mono text-xs text-neutral-300">
                {workdirPath}
              </div>
            </div>
          )}
          <ProcessInfoPanel
            runId={run.id}
            isLive={isLive}
            initial={{
              pid: run.pid,
              command: run.command,
              cpuTimeMs: liveProcess?.cpuTimeMs ?? run.cpuTimeMs,
              memoryMb: liveProcess?.memoryMb ?? run.peakMemoryMb,
              agent: run.agent ?? run.task?.agent,
              model: run.model ?? run.task?.model,
              fallbackModel: run.fallbackModel ?? run.task?.fallbackModel,
              contextTier: run.contextTier ?? run.task?.contextTier,
              reasoningEffort: run.reasoningEffort ?? run.task?.reasoningEffort,
              permissionMode: run.permissionMode ?? run.task?.permissionMode,
              timeoutLabel: run.task
                ? `${run.timeoutSeconds ?? run.task.timeoutSeconds}s`
                : run.timeoutSeconds
                  ? `${run.timeoutSeconds}s`
                  : "None",
            }}
          />
        </div>
      </details>

      {run.outputDir && (
        <section className="ui-panel p-4 sm:p-5">
          <SectionHeading icon={PackageOpen} title="Artifacts" />
          <div className="flex flex-wrap gap-2">
            {["result.md", "transcript.jsonl", "diff.patch", "run.json", "stdout.log", "stderr.log"].map(
              (name) => (
                <a
                  key={name}
                  href={`/api/runs/${run.id}/artifacts/${name}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-950/50 px-3 py-2 font-mono text-xs text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 hover:text-white"
                >
                  <Download size={12} aria-hidden="true" />
                  {name}
                </a>
              )
            )}
          </div>
        </section>
      )}

      {diff && (
        <section>
          <SectionHeading icon={GitCompareArrows} title={`Diff${commitRange ? ` (${commitRange})` : ""}`} />
          <DiffView diff={diff} />
        </section>
      )}
    </div>
  );
}
