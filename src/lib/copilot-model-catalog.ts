import { z } from "zod";

export const copilotModelOptionSchema = z.object({
  id: z.string().min(1),
  availability: z.enum(["available", "unavailable", "unverified"]),
  reason: z.string().nullable(),
});
export const copilotModelCatalogSchema = z.object({
  models: z.array(z.string()),
  modelOptions: z.array(copilotModelOptionSchema),
  verified: z.boolean(),
  checkedAt: z.string().nullable(),
  error: z.string().optional(),
  warning: z.string().optional(),
});
export type CopilotModelOption = z.infer<typeof copilotModelOptionSchema>;
export type CopilotModelCatalog = z.infer<typeof copilotModelCatalogSchema>;

interface AccountModel {
  id: string;
  policy?: { state: "enabled" | "disabled" | "unconfigured" };
}

export function buildModelCatalog(supported: string[], account: AccountModel[] | null): CopilotModelCatalog {
  const accountModels = new Map(account?.map((model) => [model.id, model]) ?? []);
  const ids = [...new Set([...supported, ...accountModels.keys()])].filter((id) => id && id !== "auto");
  const modelOptions: CopilotModelOption[] = ids.map((id) => {
    if (account === null) return { id, availability: "unverified", reason: "Account availability has not been verified." };
    const model = accountModels.get(id);
    if (!model) return { id, availability: "unavailable", reason: "Not available in this Copilot account's model catalog." };
    if (model.policy?.state === "disabled") return { id, availability: "unavailable", reason: "Disabled by account or organization policy." };
    if (model.policy?.state === "unconfigured") return { id, availability: "unavailable", reason: "Model policy has not been enabled." };
    return { id, availability: "available", reason: null };
  });
  const rank = { available: 0, unverified: 1, unavailable: 2 };
  modelOptions.sort((left, right) => rank[left.availability] - rank[right.availability]);
  return {
    models: modelOptions.filter((model) => model.availability !== "unavailable").map((model) => model.id),
    modelOptions, verified: account !== null, checkedAt: account === null ? null : new Date().toISOString(),
  };
}

export function unverifiedModelCatalog(catalog: CopilotModelCatalog): CopilotModelCatalog {
  return buildModelCatalog(catalog.modelOptions.map((model) => model.id), null);
}

export function modelOptionsForSelection(catalog: CopilotModelCatalog | null, value: string): CopilotModelOption[] {
  const options = catalog?.modelOptions ?? [];
  if (!value || options.some((model) => model.id === value)) return options;
  const availability = value === "auto" ? "available" : catalog?.verified ? "unavailable" : "unverified";
  return [{
    id: value, availability,
    reason: availability === "unavailable" ? "The saved model is not available for this Copilot account."
      : availability === "unverified" ? "The saved model has not been verified." : null,
  }, ...options];
}
