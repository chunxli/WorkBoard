import { z } from "zod";

export const createRepoSchema = z.object({
  name: z.string().min(1).max(200),
  sourceType: z.enum(["LOCAL_PATH", "GIT_URL"]),
  location: z.string().min(1).max(1000),
  defaultBranch: z.string().min(1).max(200).default("main"),
});

export const updateRepoSchema = createRepoSchema.partial();

export const createTaskSchema = z.object({
  name: z.string().min(1).max(200),
  repoId: z.string().min(1),
  prompt: z.string().min(1).max(20000),
  agent: z.string().max(200).nullish(),
  model: z.string().max(200).nullish(),
  fallbackModel: z.string().max(200).nullish(),
  contextTier: z.enum(["default", "long_context"]).nullish(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
  permissionMode: z.enum(["default", "full"]).default("default"),
  outputFormat: z.enum(["text", "json"]).default("text"),
  triggerType: z.enum(["MANUAL", "SCHEDULE", "WEBHOOK", "API"]),
  cronExpression: z.string().max(200).nullish(),
  webhookEvents: z.string().max(500).nullish(),
  enabled: z.boolean().default(true),
  useSafeBranch: z.boolean().default(true),
  waitForPreviousRuns: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(30).max(86400).default(1800),
});

export const updateTaskSchema = createTaskSchema.partial().extend({
  permissionMode: z.enum(["default", "full"]).optional(),
  outputFormat: z.enum(["text", "json"]).optional(),
  enabled: z.boolean().optional(),
  useSafeBranch: z.boolean().optional(),
  waitForPreviousRuns: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(30).max(86400).optional(),
});

export const createWebhookSchema = z.object({
  repoId: z.string().min(1),
});

export const createApiTokenSchema = z.object({
  name: z.string().min(1).max(200),
});

export const createWorkSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    directoryPath: z.string().trim().min(1).max(2000),
    prompt: z.string().min(1).max(100000),
    initialization: z.enum(["USE_PATH", "COPY_PATH", "COPY_REPO"]).default("USE_PATH"),
    sourcePath: z.string().trim().min(1).max(2000).nullish(),
    sourceRepoId: z.string().min(1).nullish(),
    defaultEngine: z.enum(["CLI", "SDK"]).default("CLI"),
    agent: z.string().trim().max(200).nullish(),
    model: z.string().trim().max(200).nullish(),
    fallbackModel: z.string().trim().max(200).nullish(),
    contextTier: z.enum(["default", "long_context"]).nullish(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
    permissionMode: z.enum(["default", "full"]).default("default"),
    outputFormat: z.enum(["text", "json"]).default("text"),
    timeoutSeconds: z.number().int().min(30).max(86400).nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.initialization === "COPY_PATH" && !value.sourcePath) {
      ctx.addIssue({
        code: "custom",
        path: ["sourcePath"],
        message: "A source path is required when copying a local directory",
      });
    }
    if (value.initialization === "COPY_REPO" && !value.sourceRepoId) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceRepoId"],
        message: "A source repo is required when copying a registered repo",
      });
    }
    if (value.model && value.fallbackModel === value.model) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackModel"],
        message: "Fallback model must differ from the primary model",
      });
    }
  });

export const reorderWorksSchema = z.object({
  workIds: z.array(z.string().min(1)).min(1).max(1000),
}).strict();

export const updateWorkSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["ACTIVE", "REVIEW", "ARCHIVED"]).optional(),
    defaultEngine: z.enum(["CLI", "SDK"]).optional(),
    agent: z.string().trim().max(200).nullish(),
    model: z.string().trim().max(200).nullish(),
    fallbackModel: z.string().trim().max(200).nullish(),
    contextTier: z.enum(["default", "long_context"]).nullish(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
    permissionMode: z.enum(["default", "full"]).optional(),
    outputFormat: z.enum(["text", "json"]).optional(),
    timeoutSeconds: z.number().int().min(30).max(86400).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.model && value.fallbackModel === value.model) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackModel"],
        message: "Fallback model must differ from the primary model",
      });
    }
  });

export const updateWorkPromptSchema = z.object({
  content: z.string().max(100000),
  expectedHash: z.string().length(64),
});

export const runWorkSchema = z
  .object({
    engine: z.enum(["CLI", "SDK"]).optional(),
    conflictMode: z.enum(["DIRECT", "COPY_ON_CONFLICT"]).default("DIRECT"),
  })
  .strict();

export const followUpWorkSchema = z.object({
  prompt: z.string().trim().min(1).max(100000),
}).strict();

export const createWorkPathShortcutSchema = z.object({
  label: z.string().trim().min(1).max(80),
  rootPath: z.string().trim().min(1).max(2000),
});

export const createPromptTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).nullish(),
  content: z.string().min(1).max(100000),
});

export const updatePromptTemplateSchema = createPromptTemplateSchema.partial();

export const systemNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const executionDefaultsSchema = z
  .object({
    defaultEngine: z.enum(["CLI", "SDK"]),
    agent: z.string().trim().max(200).nullish(),
    model: z.string().trim().max(200).nullish(),
    fallbackModel: z.string().trim().max(200).nullish(),
    contextTier: z.enum(["default", "long_context"]).nullish(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
    permissionMode: z.enum(["default", "full"]),
    outputFormat: z.enum(["text", "json"]),
    workTimeoutSeconds: z.number().int().min(30).max(86400).nullable(),
    automationTimeoutSeconds: z.number().int().min(30).max(86400),
    useSafeBranch: z.boolean(),
    waitForPreviousRuns: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.model && value.fallbackModel === value.model) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackModel"],
        message: "Fallback model must differ from the primary model",
      });
    }
    if (value.fallbackModel && !value.model) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackModel"],
        message: "A primary model is required when a fallback model is set",
      });
    }
  });

export const createExperimentSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    skillPaths: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
    includeBaseline: z.boolean().default(true),
    invocationMode: z.enum(["EXPLICIT", "AUTO"]).default("EXPLICIT"),
    engine: z.enum(["CLI", "SDK"]).default("CLI"),
  })
  .superRefine((value, ctx) => {
    if (value.skillPaths.length === 0 && !value.includeBaseline) {
      ctx.addIssue({
        code: "custom",
        path: ["skillPaths"],
        message: "Select at least one Skill or include a no-Skill baseline",
      });
    }
  });
