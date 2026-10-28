"use client";

import { useEffect, useState } from "react";
import {
  copilotModelCatalogSchema, modelOptionsForSelection, unverifiedModelCatalog,
  type CopilotModelCatalog,
} from "@/lib/copilot-model-catalog";

export function useCopilotModelCatalog() {
  const [catalog, setCatalog] = useState<CopilotModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/copilot/models${revision ? "?refresh=1" : ""}`, {
      cache: "no-store", signal: controller.signal,
    }).then(async (response) => {
      const body: unknown = await response.json();
      const parsed = copilotModelCatalogSchema.safeParse(body);
      if (!parsed.success) throw new Error(`Could not read model availability (HTTP ${response.status}).`);
      if (controller.signal.aborted) return;
      setCatalog(parsed.data);
      setError(!response.ok || !parsed.data.verified
        ? parsed.data.error ?? "Model availability has not been verified." : null);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setCatalog((current) => current ? unverifiedModelCatalog(current) : null);
      setError(failure instanceof Error ? failure.message : "Could not verify model availability.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  return { catalog, loading, error, refresh: () => {
    setLoading(true);
    setError(null);
    setRevision((value) => value + 1);
  } };
}

export function CopilotModelOptions({ catalog, value, exclude }: {
  catalog: CopilotModelCatalog | null; value: string; exclude?: string;
}) {
  return modelOptionsForSelection(catalog, value).map((model) => <option key={model.id} value={model.id}
    disabled={model.availability === "unavailable" || model.id === exclude}
    title={model.reason ?? undefined} className={model.availability === "unavailable" ? "text-neutral-500" : undefined}>
    {model.id}{model.availability === "unavailable" ? " (Unavailable)" : model.availability === "unverified" ? " (Unverified)" : ""}
  </option>);
}

export function CopilotModelStatus({ catalog, loading, error, refresh, selected = [] }: {
  catalog: CopilotModelCatalog | null; loading: boolean; error: string | null;
  refresh: () => void; selected?: string[];
}) {
  const unavailable = [...new Set(selected.filter(Boolean))].filter((id) =>
    modelOptionsForSelection(catalog, id).find((model) => model.id === id)?.availability === "unavailable");
  return <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
    <p role={error ? "alert" : "status"} className={error || unavailable.length ? "text-amber-500" : undefined}>
      {loading ? "Checking account model availability..."
        : error ?? (unavailable.length ? `Saved model unavailable: ${unavailable.join(", ")}. Choose an available model.`
          : catalog?.warning ?? "Availability follows this Copilot account; quota and transient failures can still affect requests.")}
    </p>
    <button type="button" disabled={loading} onClick={refresh} aria-label="Refresh model availability"
      className="shrink-0 underline hover:text-neutral-200 disabled:opacity-40">{error ? "Retry models" : "Refresh models"}</button>
  </div>;
}
