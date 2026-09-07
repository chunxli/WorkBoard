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
import StatusBadge from "@/components/StatusBadge";
import LiveRunLog from "@/components/LiveRunLog";
import CancelRunButton from "@/components/CancelRunButton";
import ProcessInfoPanel from "@/components/ProcessInfoPanel";
import RepoInfoPanel from "@/components/RepoInfoPanel";
import DiffView from "@/components/DiffView";
import { ownedRunWhere } from "@/lib/run-access";
import TerminalSessionActions from "@/components/TerminalSessionActions";
import { localTerminalAvailable } from "@/lib/local-terminal-policy";
import { isTerminalResumeReady } from "@/lib/terminal-resume";
import { readRunDiffPreview, readRunLogTail } from "@/lib/run-artifacts";
import MetaChip from "@/components/MetaChip";
import SectionHeading from "@/components/SectionHeading";
import MarkdownResult from "@/components/MarkdownResult";
import { ArrowLeft, Clock3, Download, FileText, GitBranch, GitCompareArrows, GitCommitHorizontal, Monitor, PackageOpen, TerminalSquare, Zap } from "lucide-react";
import { isTerminalRunTrigger } from "@/lib/terminal-run";

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
      terminalLaunches: { select: { status: true }, take: 1 },
    },
  });
  if (!run) notFound();

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
  const terminalLaunchStatus = run.terminalLaunches[0]?.status;
  const resumeReady =
    Boolean(run.copilotSessionId) &&
    canOpenTerminal &&
    await isTerminalResumeReady({
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      work: run.work,
    });
  const commitRange =
    run.baseCommit && run.finalCommit
      ? `${run.baseCommit.slice(0, 8)}..${run.finalCommit.slice(0, 8)}`
      : null;

  return (
    <div className="space-y-6">
      <header className="border-b border-neutral-800 pb-5">
        <Link
          href={run.task ? `/tasks/${run.task.id}` : run.work ? `/work/${run.work.id}` : "/runs"}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500 hover:text-emerald-300"
        >
          <ArrowLeft size={13} aria-hidden="true" />
          {run.task?.name ?? run.work?.name ?? "Runs"}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-white">Run <span className="font-mono">{run.id.slice(0, 8)}</span></h1>
          <StatusBadge status={run.status} />
          {isLive && <CancelRunButton runId={run.id} />}
        </div>
        {run.copilotSessionId && canOpenTerminal && (
          <div className="mt-3">
            <TerminalSessionActions
              key={`${run.id}:${run.status}:${terminalLaunchStatus ?? "none"}`}
              runId={run.id}
              canResume={!ownerArchived && resumeReady}
              canSync={
                run.status === "RUNNING" &&
                isTerminalRunTrigger(run.trigger) &&
                terminalLaunchStatus !== undefined &&
                terminalLaunchStatus !== "COMPLETED"
              }
            />
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <MetaChip icon={Zap}>{run.trigger}</MetaChip>
          {run.branchName && <MetaChip icon={GitBranch} mono>{run.branchName}</MetaChip>}
          {run.startedAt && <MetaChip icon={Clock3}>{formatDuration(run.startedAt, run.finishedAt)}</MetaChip>}
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
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
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
        {run.errorMessage && <p className="mt-2 text-sm text-red-400">{run.errorMessage}</p>}
      </header>

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
          <div className="mt-1 truncate font-mono text-xs text-neutral-300" title={workdirPath}>
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

      {run.finalOutput && !isLive && (
        <section className="border-l-2 border-emerald-600 pl-4">
          <SectionHeading icon={FileText} title="Result" />
          <MarkdownResult content={run.finalOutput} />
        </section>
      )}

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

      <section>
        <SectionHeading icon={TerminalSquare} title="Output" />
        <LiveRunLog
          runId={run.id}
          initialLog={log}
          isLive={isLive}
          outputFormat={(run.outputFormat ?? run.task?.outputFormat ?? "text") === "json" ? "json" : "text"}
        />
      </section>

      {diff && (
        <section>
          <SectionHeading icon={GitCompareArrows} title={`Diff${commitRange ? ` (${commitRange})` : ""}`} />
          <DiffView diff={diff} />
        </section>
      )}
    </div>
  );
}
