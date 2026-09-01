interface RepoInfo {
  currentBranch: string;
  defaultBranch: string;
  remoteUrl: string | null;
  workdirPath: string;
}

/** Static repo/branch context for a run — no polling needed, this never changes after the run starts. */
export default function RepoInfoPanel({ info }: { info: RepoInfo }) {
  return (
    <div className="ui-panel p-4 sm:p-5">
      <h2 className="mb-4 text-sm font-bold text-neutral-200">Repo info</h2>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-neutral-500">当前 Branch</div>
          <div className="font-mono">{info.currentBranch}</div>
        </div>
        <div>
          <div className="text-neutral-500">默认 Branch</div>
          <div className="font-mono">{info.defaultBranch}</div>
        </div>
        <div className="col-span-2 sm:col-span-2">
          <div className="text-neutral-500">远程 Repo URL</div>
          <div className="truncate font-mono text-xs" title={info.remoteUrl ?? undefined}>
            {info.remoteUrl ?? "-"}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <div className="text-neutral-500 text-sm">当前 Repo Path</div>
        <div className="truncate font-mono text-xs text-neutral-300" title={info.workdirPath}>
          {info.workdirPath}
        </div>
      </div>
    </div>
  );
}
