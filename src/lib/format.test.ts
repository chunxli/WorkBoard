import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./format";

describe("formatTokenCount", () => {
  it("keeps small counts exact and compacts large usage", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(34_450_908)).toBe("34.5M");
  });
});