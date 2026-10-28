import { describe, expect, it } from "vitest";
import { buildModelCatalog, modelOptionsForSelection, unverifiedModelCatalog } from "./copilot-model-catalog";

describe("account model availability", () => {
  it("disables unsupported account entries and explicit policy restrictions, not listed models without policy", () => {
    const catalog = buildModelCatalog(["auto", "missing", "enabled", "disabled", "unconfigured"], [
      { id: "auto" }, { id: "enabled", policy: { state: "enabled" } },
      { id: "disabled", policy: { state: "disabled" } },
      { id: "unconfigured", policy: { state: "unconfigured" } }, { id: "service-only" },
    ]);
    expect(catalog.models).toEqual(["enabled", "service-only"]);
    expect(catalog.modelOptions).toHaveLength(5);
    expect(catalog.modelOptions.filter((model) => model.availability === "unavailable").map((model) => model.id))
      .toEqual(["missing", "disabled", "unconfigured"]);
    expect(catalog.verified).toBe(true);
    expect(catalog.checkedAt).not.toBeNull();
  });

  it("retains all choices as unverified when availability lookup fails", () => {
    const catalog = buildModelCatalog(["model-a", "model-b"], null);
    expect(catalog.models).toEqual(["model-a", "model-b"]);
    expect(catalog.modelOptions.every((model) => model.availability === "unverified")).toBe(true);
    expect(catalog.verified).toBe(false);
    expect(catalog.checkedAt).toBeNull();
    expect(unverifiedModelCatalog(buildModelCatalog(["model-a"], [])).models).toEqual(["model-a"]);
  });

  it("preserves a saved unavailable or not-yet-verified value without changing Auto semantics", () => {
    const verified = buildModelCatalog(["available"], [{ id: "available" }]);
    expect(modelOptionsForSelection(verified, "saved-missing")[0]).toMatchObject({ id: "saved-missing", availability: "unavailable" });
    expect(modelOptionsForSelection(null, "saved-missing")[0]).toMatchObject({ id: "saved-missing", availability: "unverified" });
    expect(modelOptionsForSelection(verified, "auto")[0]).toMatchObject({ id: "auto", availability: "available" });
    expect(modelOptionsForSelection(verified, "")).toEqual(verified.modelOptions);
  });
});
