import { describe, expect, it } from "vitest";
import { validateCompleteWorkOrder } from "./work-order";

describe("validateCompleteWorkOrder", () => {
  it("accepts a permutation of every current Work ID", () => {
    expect(validateCompleteWorkOrder(["a", "b", "c"], ["c", "a", "b"])).toBeNull();
  });

  it("rejects duplicates, omissions, and inaccessible IDs", () => {
    expect(validateCompleteWorkOrder(["a", "b"], ["a", "a"])).toContain("duplicate");
    expect(validateCompleteWorkOrder(["a", "b"], ["a"])).toContain("refresh");
    expect(validateCompleteWorkOrder(["a", "b"], ["a", "x"])).toContain("inaccessible");
  });
});