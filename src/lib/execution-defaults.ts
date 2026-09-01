export type ExecutionContextTier = "" | "default" | "long_context";
export type ExecutionReasoningEffort =
  | ""
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ExecutionDefaultsValue {
  defaultEngine: "CLI" | "SDK";
  agent: string;
  model: string;
  fallbackModel: string;
  contextTier: ExecutionContextTier;
  reasoningEffort: ExecutionReasoningEffort;
  permissionMode: "default" | "full";
  outputFormat: "text" | "json";
  workTimeoutSeconds: number | null;
  automationTimeoutSeconds: number;
  useSafeBranch: boolean;
  waitForPreviousRuns: boolean;
}

export interface WorkExecutionSettingsValue extends Pick<
  ExecutionDefaultsValue,
  | "defaultEngine"
  | "agent"
  | "model"
  | "fallbackModel"
  | "contextTier"
  | "reasoningEffort"
  | "permissionMode"
  | "outputFormat"
> {
  timeoutSeconds: number | null;
}

export const BUILT_IN_EXECUTION_DEFAULTS: ExecutionDefaultsValue = {
  defaultEngine: "CLI",
  agent: "",
  model: "",
  fallbackModel: "",
  contextTier: "",
  reasoningEffort: "",
  permissionMode: "default",
  outputFormat: "text",
  workTimeoutSeconds: null,
  automationTimeoutSeconds: 1800,
  useSafeBranch: true,
  waitForPreviousRuns: false,
};

interface StoredExecutionDefaults {
  defaultEngine?: "CLI" | "SDK" | null;
  agent?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  contextTier?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: string | null;
  outputFormat?: string | null;
  workTimeoutSeconds?: number | null;
  automationTimeoutSeconds?: number | null;
  useSafeBranch?: boolean | null;
  waitForPreviousRuns?: boolean | null;
}

export function normalizeExecutionDefaults(
  stored?: StoredExecutionDefaults | null
): ExecutionDefaultsValue {
  if (!stored) return { ...BUILT_IN_EXECUTION_DEFAULTS };
  return {
    defaultEngine: stored.defaultEngine === "SDK" ? "SDK" : "CLI",
    agent: stored.agent ?? "",
    model: stored.model ?? "",
    fallbackModel: stored.fallbackModel ?? "",
    contextTier:
      stored.contextTier === "default" || stored.contextTier === "long_context"
        ? stored.contextTier
        : "",
    reasoningEffort:
      stored.reasoningEffort &&
      ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        stored.reasoningEffort
      )
        ? stored.reasoningEffort as ExecutionReasoningEffort
        : "",
    permissionMode: stored.permissionMode === "full" ? "full" : "default",
    outputFormat: stored.outputFormat === "json" ? "json" : "text",
    workTimeoutSeconds: stored.workTimeoutSeconds ?? null,
    automationTimeoutSeconds:
      stored.automationTimeoutSeconds ?? BUILT_IN_EXECUTION_DEFAULTS.automationTimeoutSeconds,
    useSafeBranch: stored.useSafeBranch ?? true,
    waitForPreviousRuns: stored.waitForPreviousRuns ?? false,
  };
}

export function executionDefaultsPayload(value: ExecutionDefaultsValue) {
  return {
    defaultEngine: value.defaultEngine,
    agent: value.agent.trim() || null,
    model: value.model || null,
    fallbackModel: value.fallbackModel || null,
    contextTier: value.contextTier || null,
    reasoningEffort: value.reasoningEffort || null,
    permissionMode: value.permissionMode,
    outputFormat: value.outputFormat,
    workTimeoutSeconds: value.workTimeoutSeconds,
    automationTimeoutSeconds: value.automationTimeoutSeconds,
    useSafeBranch: value.useSafeBranch,
    waitForPreviousRuns: value.waitForPreviousRuns,
  };
}

export function workDefaultsPayload(value: ExecutionDefaultsValue) {
  const defaults = executionDefaultsPayload(value);
  return {
    defaultEngine: defaults.defaultEngine,
    agent: defaults.agent,
    model: defaults.model,
    fallbackModel: defaults.fallbackModel,
    contextTier: defaults.contextTier,
    reasoningEffort: defaults.reasoningEffort,
    permissionMode: defaults.permissionMode,
    outputFormat: defaults.outputFormat,
    timeoutSeconds: defaults.workTimeoutSeconds,
  };
}

export function workExecutionSettingsValue(
  value: ExecutionDefaultsValue
): WorkExecutionSettingsValue {
  return {
    defaultEngine: value.defaultEngine,
    agent: value.agent,
    model: value.model,
    fallbackModel: value.fallbackModel,
    contextTier: value.contextTier,
    reasoningEffort: value.reasoningEffort,
    permissionMode: value.permissionMode,
    outputFormat: value.outputFormat,
    timeoutSeconds: value.workTimeoutSeconds,
  };
}

export function automationDefaultsPayload(value: ExecutionDefaultsValue) {
  const defaults = executionDefaultsPayload(value);
  return {
    agent: defaults.agent,
    model: defaults.model,
    fallbackModel: defaults.fallbackModel,
    contextTier: defaults.contextTier,
    reasoningEffort: defaults.reasoningEffort,
    permissionMode: defaults.permissionMode,
    outputFormat: defaults.outputFormat,
    timeoutSeconds: defaults.automationTimeoutSeconds,
    useSafeBranch: defaults.useSafeBranch,
    waitForPreviousRuns: defaults.waitForPreviousRuns,
  };
}