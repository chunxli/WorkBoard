import { describe, expect, it } from "vitest";
import { nextColorTheme, resolveColorTheme } from "./theme";

describe("color theme", () => {
  it("prefers a persisted explicit theme", () => {
    expect(resolveColorTheme("light", false)).toBe("light");
    expect(resolveColorTheme("dark", true)).toBe("dark");
  });

  it("falls back to the operating system preference", () => {
    expect(resolveColorTheme(null, true)).toBe("light");
    expect(resolveColorTheme("unknown", false)).toBe("dark");
  });

  it("toggles between light and dark", () => {
    expect(nextColorTheme("light")).toBe("dark");
    expect(nextColorTheme("dark")).toBe("light");
  });
});