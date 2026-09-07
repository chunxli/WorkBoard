"use client";

import { useEffect, useState } from "react";

interface ProcessInfo {
  pid: number | null;
  command: string | null;
  cpuTimeMs: number | null;
  memoryMb: number | null;
  agent?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  contextTier?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: string | null;
  timeoutLabel?: string | null;
}

export function mergeProcessInfo(
  current: ProcessInfo,
  update: Partial<ProcessInfo>
): ProcessInfo {
  return { ...current, ...update };
}

function formatCpuTime(ms: number | null): string {
  if (ms == null) return "-";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

const CONTEXT_TIER_LABELS: Record<string, string> = {
  default: "Default",
  long_context: "Long context",
};

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/** Process info panel: static for finished runs, polls the process endpoint every 3s while live. */
export default function ProcessInfoPanel({
  runId,
  initial,
  isLive,
}: {
  runId: string;
  initial: ProcessInfo;
  isLive: boolean;
}) {
  const [info, setInfo] = useState<ProcessInfo>(initial);

  useEffect(() => {
    if (!isLive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/process`);
        if (!stopped && res.ok) {
          const update = await res.json() as Partial<ProcessInfo>;
          setInfo((current) => mergeProcessInfo(current, update));
        }
      } finally {
        if (!stopped) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, isLive]);

  if (!info.pid && !info.command) return null;

  return (
    <div className="ui-panel p-4 sm:p-5">
      <h2 className="mb-4 text-sm font-bold text-neutral-200">Process info</h2>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-neutral-500">PID</div>
          <div className="font-mono">{info.pid ?? "-"}</div>
        </div>
        <div>
          <div className="text-neutral-500">进程名称</div>
          <div className="font-mono">copilot</div>
        </div>
        <div>
          <div className="text-neutral-500">CPU 时间</div>
          <div>{formatCpuTime(info.cpuTimeMs)}</div>
        </div>
        <div>
          <div className="text-neutral-500">内存占用</div>
          <div>{info.memoryMb != null ? `${info.memoryMb.toFixed(1)} MB` : "-"}</div>
        </div>
        <div>
          <div className="text-neutral-500">Model</div>
          <div className="font-mono">{info.model || "auto"}</div>
        </div>
        <div>
          <div className="text-neutral-500">Fallback Model</div>
          <div className="font-mono">{info.fallbackModel || "-"}</div>
        </div>
        <div>
          <div className="text-neutral-500">Agent</div>
          <div className="font-mono">{info.agent || "default"}</div>
        </div>
        <div>
          <div className="text-neutral-500">Context Size</div>
          <div>{info.contextTier ? (CONTEXT_TIER_LABELS[info.contextTier] ?? info.contextTier) : "Default"}</div>
        </div>
        <div>
          <div className="text-neutral-500">Think Effort</div>
          <div>
            {info.reasoningEffort
              ? (REASONING_EFFORT_LABELS[info.reasoningEffort] ?? info.reasoningEffort)
              : "-"}
          </div>
        </div>
        <div>
          <div className="text-neutral-500">Permissions</div>
          <div>{info.permissionMode === "full" ? "Full access" : "Standard tools"}</div>
        </div>
        <div>
          <div className="text-neutral-500">Timeout</div>
          <div>{info.timeoutLabel ?? "-"}</div>
        </div>
      </div>
      {info.command && (
        <div className="mt-3">
          <div className="text-neutral-500 text-sm">命令</div>
          <div className="truncate font-mono text-xs text-neutral-300" title={info.command}>
            {info.command}
          </div>
        </div>
      )}
    </div>
  );
}
