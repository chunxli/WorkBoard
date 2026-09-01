"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Boxes, ChevronDown, MessageSquareText, Plus, SlidersHorizontal, Zap } from "lucide-react";
import type { Repo } from "@/generated/prisma/client";
import CronScheduleInput from "@/components/CronScheduleInput";
import WebhookEventsInput from "@/components/WebhookEventsInput";
import AutomationFormSection from "@/components/AutomationFormSection";
import AutomationResourcePicker from "@/components/AutomationResourcePicker";
import type { ExecutionDefaultsValue } from "@/lib/execution-defaults";

function deriveNameFromPrompt(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, " ");
  if (!clean) return "";
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

export default function CreateTaskForm({
  repos,
  initialResourceId,
  executionDefaults,
}: {
  repos: Repo[];
  initialResourceId?: string;
  executionDefaults: ExecutionDefaultsValue;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const selectedInitialResource = repos.some((repo) => repo.id === initialResourceId)
    ? initialResourceId!
    : repos[0]?.id ?? "";
  const initiallyEditingResource = Boolean(
    initialResourceId && repos.some((repo) => repo.id === initialResourceId)
  );
  const [repoId, setRepoId] = useState(selectedInitialResource);
  const [resourceEditorOpen, setResourceEditorOpen] = useState(
    repos.length === 0 || initiallyEditingResource
  );
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState(executionDefaults.agent);
  const [model, setModel] = useState(executionDefaults.model);
  const [fallbackModel, setFallbackModel] = useState(executionDefaults.fallbackModel);
  const [contextTier, setContextTier] = useState<"" | "default" | "long_context">(
    executionDefaults.contextTier
  );
  const [reasoningEffort, setReasoningEffort] = useState<
    "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >(executionDefaults.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<"default" | "full">(
    executionDefaults.permissionMode
  );
  const [outputFormat, setOutputFormat] = useState<"text" | "json">(
    executionDefaults.outputFormat
  );
  const [triggerType, setTriggerType] = useState<"MANUAL" | "SCHEDULE" | "WEBHOOK" | "API">("MANUAL");
  const [cronExpression, setCronExpression] = useState("0 * * * *");
  const [webhookEvents, setWebhookEvents] = useState("");
  const [useSafeBranch, setUseSafeBranch] = useState(executionDefaults.useSafeBranch);
  const [waitForPreviousRuns, setWaitForPreviousRuns] = useState(
    executionDefaults.waitForPreviousRuns
  );
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    executionDefaults.automationTimeoutSeconds
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/copilot/models")
      .then((res) => (res.ok ? res.json() : { models: [] }))
      .then((data: { models?: string[] }) => setAvailableModels(data.models ?? []))
      .catch(() => {});
  }, []);

  function onPromptChange(next: string) {
    setPrompt(next);
    if (!nameTouched) setName(deriveNameFromPrompt(next));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!repoId || resourceEditorOpen) {
      setError(
        resourceEditorOpen
          ? "Save or close the Resource editor before creating the Automation"
          : "Select or create a Resource first"
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || deriveNameFromPrompt(prompt) || "Untitled task",
          repoId,
          prompt,
          agent: agent || null,
          model: model || null,
          fallbackModel: fallbackModel || null,
          contextTier: contextTier || null,
          reasoningEffort: reasoningEffort || null,
          permissionMode,
          outputFormat,
          triggerType,
          cronExpression: triggerType === "SCHEDULE" ? cronExpression : null,
          webhookEvents: triggerType === "WEBHOOK" ? webhookEvents : null,
          useSafeBranch,
          waitForPreviousRuns,
          timeoutSeconds,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? JSON.stringify(body.error) : "Failed to create automation");
      }
      const task = await res.json();
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="ui-panel ui-panel-elevated overflow-hidden">
      <AutomationFormSection step="01" title="Resource" icon={Boxes}>
        <AutomationResourcePicker
          initialResources={repos}
          value={repoId}
          onChange={setRepoId}
          initiallyEditing={initiallyEditingResource}
          showLabel={false}
          onEditorOpenChange={setResourceEditorOpen}
        />
      </AutomationFormSection>

      <AutomationFormSection step="02" title="Instruction" icon={MessageSquareText}>
        <div className="space-y-4">
          <label className="block text-xs font-medium text-neutral-400">
            Prompt
            <textarea
              className="ui-input mt-1.5 min-h-40 w-full resize-y px-3 py-2.5 text-sm leading-6"
              placeholder="告诉 Copilot 做什么，例如 '修复失败的测试并总结改动'"
              rows={5}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              required
            />
          </label>
          <label className="block text-xs font-medium text-neutral-400">
            Automation name
            <input
              className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
              placeholder="根据 Prompt 自动生成"
              value={name}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
            />
          </label>
        </div>
      </AutomationFormSection>

      <AutomationFormSection step="03" title="Trigger" icon={Zap}>
        <div className="space-y-4">
          <label className="block text-xs font-medium text-neutral-400">
            Trigger type
            <select
              className="ui-input mt-1.5 w-full px-3 py-2 text-sm sm:max-w-xs"
              value={triggerType}
              onChange={(event) => setTriggerType(event.target.value as typeof triggerType)}
            >
              <option value="MANUAL">手动触发</option>
              <option value="SCHEDULE">定时任务</option>
              <option value="WEBHOOK">GitHub webhook</option>
              <option value="API">外部 API</option>
            </select>
          </label>
          {triggerType === "SCHEDULE" && (
            <CronScheduleInput value={cronExpression} onChange={setCronExpression} />
          )}
          {triggerType === "WEBHOOK" && (
            <WebhookEventsInput value={webhookEvents} onChange={setWebhookEvents} />
          )}
          <label className="flex items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950/30 p-3 text-sm text-neutral-300">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-emerald-500"
              checked={waitForPreviousRuns}
              onChange={(event) => setWaitForPreviousRuns(event.target.checked)}
            />
            <span>
              等待此前所有 Run 完成后再开始
              <span className="mt-0.5 block text-xs text-neutral-500">
                同一 Resource 的 Run 始终串行；启用后同时等待其他 Resource。
              </span>
            </span>
          </label>
        </div>
      </AutomationFormSection>

      <details className="group border-t border-neutral-800">
        <summary className="grid cursor-pointer list-none gap-4 p-4 hover:bg-neutral-950/20 sm:p-5 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-6">
          <div className="flex items-center gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-neutral-700 bg-neutral-950 font-mono text-[10px] font-bold text-neutral-500">
              04
            </span>
            <span className="flex items-center gap-2 text-sm font-bold text-neutral-200">
              <SlidersHorizontal size={15} className="text-emerald-400" aria-hidden="true" />
              Execution
            </span>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="truncate font-mono text-[11px] text-neutral-500">
              {model || "Auto model"} · {timeoutSeconds}s · {useSafeBranch ? "Safe branch" : "Direct branch"}
            </span>
            <ChevronDown size={15} className="shrink-0 text-neutral-500 transition-transform group-open:rotate-180" aria-hidden="true" />
          </div>
        </summary>
        <div className="grid gap-4 border-t border-neutral-800 bg-neutral-950/20 p-4 sm:p-5 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-6">
          <div className="hidden md:block" />
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-neutral-400">
              Agent
              <input
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
                placeholder="Default agent"
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-neutral-400">
              Model
              <select
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
                value={model}
                onChange={(event) => {
                  const nextModel = event.target.value;
                  setModel(nextModel);
                  if (!nextModel || fallbackModel === nextModel) setFallbackModel("");
                }}
              >
                <option value="">Auto</option>
                {availableModels.map((availableModel) => (
                  <option key={availableModel} value={availableModel}>{availableModel}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-neutral-400 sm:col-span-2">
              Fallback model
              <select
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                value={fallbackModel}
                onChange={(event) => setFallbackModel(event.target.value)}
                disabled={!model}
              >
                <option value="">{model ? "None" : "Select a primary model first"}</option>
                {availableModels.map((availableModel) => (
                  <option key={availableModel} value={availableModel} disabled={availableModel === model}>
                    {availableModel}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-neutral-400">
              Context size
              <select
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
                value={contextTier}
                onChange={(event) => setContextTier(event.target.value as typeof contextTier)}
              >
                <option value="">Default</option>
                <option value="default">default</option>
                <option value="long_context">long_context</option>
              </select>
            </label>
            <label className="text-xs font-medium text-neutral-400">
              Think effort
              <select
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value as typeof reasoningEffort)}
              >
                <option value="">Default</option>
                {(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map(
                  (effort) => <option key={effort} value={effort}>{effort}</option>
                )}
              </select>
            </label>
            <label className="text-xs font-medium text-neutral-400">
              Permissions
              <select
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as "default" | "full")}
              >
                <option value="default">Standard tools</option>
                <option value="full">Full access</option>
              </select>
            </label>
            <label className="text-xs font-medium text-neutral-400">
              Output format
              <select
                className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
                value={outputFormat}
                onChange={(event) => setOutputFormat(event.target.value as "text" | "json")}
              >
                <option value="text">Readable text</option>
                <option value="json">Raw JSON events</option>
              </select>
            </label>
            <label className="text-xs font-medium text-neutral-400">
              Timeout (seconds)
              <input
                type="number"
                className="ui-input mt-1.5 w-full px-3 py-2 font-mono text-sm"
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(Number(event.target.value))}
                min={30}
              />
            </label>
            <label className="flex items-center gap-3 self-end rounded-md border border-neutral-800 bg-neutral-950/30 p-3 text-sm text-neutral-300">
              <input
                type="checkbox"
                className="size-4 accent-emerald-500"
                checked={useSafeBranch}
                onChange={(event) => setUseSafeBranch(event.target.checked)}
              />
              Create a safe branch for every run
            </label>
          </div>
        </div>
      </details>

      {error && (
        <p role="alert" className="border-t border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300 sm:px-5">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t border-neutral-800 bg-neutral-950/30 px-4 py-4 sm:px-5">
        <Link href="/tasks" className="ui-secondary-button">Cancel</Link>
        <button
          type="submit"
          disabled={submitting || !repoId || resourceEditorOpen}
          title={resourceEditorOpen ? "Save or close the Resource editor first" : undefined}
          className="ui-primary-button"
        >
          <Plus size={15} aria-hidden="true" />
          {submitting ? "Creating..." : "Create automation"}
        </button>
      </div>
    </form>
  );
}
