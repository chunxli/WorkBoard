import { describe, expect, it } from "vitest";
import { inferResourceName, inferResourceSourceType } from "./resource-input";

describe("Resource input inference", () => {
  it("recognizes local Windows and POSIX paths", () => {
    expect(inferResourceSourceType("C:\\work\\codeboard")).toBe("LOCAL_PATH");
    expect(inferResourceSourceType("/work/codeboard")).toBe("LOCAL_PATH");
    expect(inferResourceName("C:\\work\\codeboard\\")).toBe("codeboard");
  });

  it("recognizes HTTPS and SSH Git locations", () => {
    expect(inferResourceSourceType("https://github.com/acme/app.git")).toBe("GIT_URL");
    expect(inferResourceSourceType("git@github.com:acme/app.git")).toBe("GIT_URL");
    expect(inferResourceName("https://github.com/acme/app.git")).toBe("app");
  });
});