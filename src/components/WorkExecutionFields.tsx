"use client";

import { useEffect, useState } from "react";
import {
  BUILT_IN_EXECUTION_DEFAULTS,
  type ExecutionContextTier,
  type ExecutionReasoningEffort,
  type WorkExecutionSettingsValue,
  workDefaultsPayload,
  workExecutionSettingsValue,
} from "@/lib/execution-defaults";

export type WorkContextTier = ExecutionContextTier;
export type WorkReasoningEffort = ExecutionReasoningEffort;
export type { WorkExecutionSettingsValue } from "@/lib/execution-defaults";

export const DEFAULT_WORK_EXECUTION_SETTINGS = workExecutionSettingsValue(
  BUILT_IN_EXECUTION_DEFAULTS
);

export function workExecutionSettingsPayload(value: WorkExecutionSettingsValue) {
  return workDefaultsPayload({
    ...BUILT_IN_EXECUTION_DEFAULTS,
    ...value,
    workTimeoutSeconds: value.timeoutSeconds,
  });
}

export default function WorkExecutionFields({
  value,
  onChange,
  keepCliFieldsEnabled = false,
}: {
  value: WorkExecutionSettingsValue;
  onChange: (value: WorkExecutionSettingsValue) => void;
  keepCliFieldsEnabled?: boolean;
}) {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const cli = value.defaultEngine === "CLI" || keepCliFieldsEnabled;

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/copilot/models", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { models: [] }))
      .then((data: { models?: string[] }) => setAvailableModels(data.models ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  function update<Key extends keyof WorkExecutionSettingsValue>(
    key: Key,
    nextValue: WorkExecutionSettingsValue[Key]
  ) {
    onChange({ ...value, [key]: nextValue });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-xs text-neutral-400">
        Engine
        <select
          value={value.defaultEngine}
          onChange={(event) => update("defaultEngine", event.target.value as "CLI" | "SDK")}
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
        >
          <option value="CLI">Copilot CLI</option>
          <option value="SDK">Copilot SDK</option>
        </select>
      </label>

      <label className="text-xs text-neutral-400">
        Model
        <select
          value={value.model}
          onChange={(event) => {
            const model = event.target.value;
            onChange({
              ...value,
              model,
              fallbackModel: !model || value.fallbackModel === model ? "" : value.fallbackModel,
            });
          }}
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
        >
          <option value="">Auto</option>
          {value.model && !availableModels.includes(value.model) && (
            <option value={value.model}>{value.model} (current)</option>
          )}
          {availableModels.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
      </label>

      <label className={`text-xs ${cli ? "text-neutral-400" : "text-neutral-600"}`}>
        Fallback model (CLI)
        <select
          value={value.fallbackModel}
          onChange={(event) => update("fallbackModel", event.target.value)}
          disabled={!cli || !value.model}
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">None</option>
          {value.fallbackModel && !availableModels.includes(value.fallbackModel) && (
            <option value={value.fallbackModel}>{value.fallbackModel} (current)</option>
          )}
          {availableModels.map((model) => (
            <option key={model} value={model} disabled={model === value.model}>{model}</option>
          ))}
        </select>
      </label>

      <label className={`text-xs ${cli ? "text-neutral-400" : "text-neutral-600"}`}>
        Agent (CLI)
        <input
          value={value.agent}
          onChange={(event) => update("agent", event.target.value)}
          disabled={!cli}
          maxLength={200}
          placeholder="Default agent"
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        />
      </label>

      <label className="text-xs text-neutral-400">
        Context
        <select
          value={value.contextTier}
          onChange={(event) => update("contextTier", event.target.value as ExecutionContextTier)}
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
        >
          <option value="">Default</option>
          <option value="default">default</option>
          <option value="long_context">long_context</option>
        </select>
      </label>

      <label className="text-xs text-neutral-400">
        Think effort
        <select
          value={value.reasoningEffort}
          onChange={(event) => update("reasoningEffort", event.target.value as ExecutionReasoningEffort)}
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
        >
          <option value="">Default</option>
          {(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map(
            (effort) => <option key={effort} value={effort}>{effort}</option>
          )}
        </select>
      </label>

      <label className={`text-xs ${cli ? "text-neutral-400" : "text-neutral-600"}`}>
        Permissions (CLI)
        <select
          value={value.permissionMode}
          onChange={(event) => update("permissionMode", event.target.value as "default" | "full")}
          disabled={!cli}
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="default">Standard tools</option>
          <option value="full">Full access</option>
        </select>
      </label>

      <label className="text-xs text-neutral-400">
        Output
        <select
          value={value.outputFormat}
          onChange={(event) => update("outputFormat", event.target.value as "text" | "json")}
          className="ui-input mt-1.5 w-full px-3 py-2 text-sm"
        >
          <option value="text">Readable text</option>
          <option value="json">JSON events</option>
        </select>
      </label>

      <label className="text-xs text-neutral-400">
        Timeout
        <div className="mt-1.5 grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] gap-2">
          <select
            aria-label="Work timeout mode"
            value={value.timeoutSeconds === null ? "none" : "custom"}
            onChange={(event) => update(
              "timeoutSeconds",
              event.target.value === "none" ? null : 1800
            )}
            className="ui-input w-full px-2 py-2 text-sm"
          >
            <option value="none">None</option>
            <option value="custom">Custom</option>
          </select>
          <input
            aria-label="Work timeout seconds"
            type="number"
            min={30}
            max={86400}
            value={value.timeoutSeconds ?? ""}
            onChange={(event) => {
              if (event.target.valueAsNumber >= 30) {
                update("timeoutSeconds", event.target.valueAsNumber);
              }
            }}
            disabled={value.timeoutSeconds === null}
            placeholder="Seconds"
            className="ui-input min-w-0 px-2 py-2 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-45"
          />
        </div>
      </label>
    </div>
  );
}