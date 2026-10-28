import { execFile } from "node:child_process";
import { CopilotClient, RuntimeConnection, type ModelInfo } from "@github/copilot-sdk";
import { resolveCopilotCliExecutable } from "@/lib/copilot-cli-executable";
import { buildCopilotEnvironment } from "@/lib/copilot-runner";
import { buildModelCatalog, type CopilotModelCatalog } from "@/lib/copilot-model-catalog";

let supportedModels: string[] | null = null;
let cached: { catalog: CopilotModelCatalog; expiresAt: number } | null = null;
let pending: Promise<CopilotModelCatalog> | null = null;

async function readSupportedModels(): Promise<string[]> {
  if (supportedModels) return supportedModels;
  const output = await new Promise<string>((resolve, reject) => {
    execFile(resolveCopilotCliExecutable(), ["help", "config"], {
      windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
      env: buildCopilotEnvironment(),
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  const section = output.split(/`model`:/)[1]?.split(/`\w+`:/)[0] ?? "";
  const models = [...new Set([...section.matchAll(/"([^"]+)"/g)].map((match) => match[1]))];
  if (models.length === 0) throw new Error("The native CLI returned no supported model IDs.");
  supportedModels = models;
  return models;
}

async function readAccountModels(): Promise<ModelInfo[]> {
  const client = new CopilotClient({
    mode: "copilot-cli",
    connection: RuntimeConnection.forStdio({ path: resolveCopilotCliExecutable() }),
    env: buildCopilotEnvironment(), workingDirectory: process.cwd(), logLevel: "error",
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await Promise.race([
      (async () => { await client.start(); return client.listModels(); })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Account model verification timed out.")), 20000);
      }),
    ]);
    if (models.filter((model) => model.id !== "auto").length === 0) {
      throw new Error("The account returned no verifiable model catalog.");
    }
    return models;
  } finally {
    clearTimeout(deadline);
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const errors = await Promise.race([
        client.stop(),
        new Promise<never>((_, reject) => {
          cleanupDeadline = setTimeout(() => reject(new Error("Model metadata shutdown timed out.")), 5000);
        }),
      ]);
      if (errors.length) throw new AggregateError(errors, "The model metadata runtime could not be stopped.");
    } catch (error) {
      try { await client.forceStop(); }
      catch (forcedError) { throw new AggregateError([error, forcedError], "Model metadata cleanup failed."); }
      throw error;
    } finally { clearTimeout(cleanupDeadline); }
  }
}

async function loadModelCatalog(): Promise<CopilotModelCatalog> {
  const [supported, account] = await Promise.allSettled([readSupportedModels(), readAccountModels()]);
  if (supported.status === "rejected") console.error("[Work Board] CLI model support lookup failed.");
  if (account.status === "rejected") console.error("[Work Board] Account model availability verification failed.");
  const ids = [...new Set([
    ...(supported.status === "fulfilled" ? supported.value : []),
    ...(cached?.catalog.modelOptions.map((model) => model.id) ?? []),
  ])];
  const catalog = buildModelCatalog(ids, account.status === "fulfilled" ? account.value : null);
  if (!catalog.verified) catalog.error = "Could not verify account model availability. Existing choices are unverified; retry before relying on them.";
  if (supported.status === "rejected") catalog.warning = "The CLI support list could not be read; only account or previously known models are shown.";
  return catalog;
}

export async function getCopilotModelCatalog(refresh = false): Promise<CopilotModelCatalog> {
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.catalog;
  if (pending) return pending;
  pending = loadModelCatalog().then((catalog) => {
    if (catalog.verified) cached = { catalog, expiresAt: Date.now() + 60000 };
    else if (cached) cached.expiresAt = 0;
    return catalog;
  }).finally(() => { pending = null; });
  return pending;
}

export async function getSupportedModels(): Promise<string[]> {
  return (await getCopilotModelCatalog()).models;
}
