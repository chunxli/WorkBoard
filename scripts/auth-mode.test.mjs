import { describe, expect, it } from "vitest";
import { nextHostnameArgs, resolveRuntimeAuthMode } from "./auth-mode.mjs";

describe("Next.js runtime auth mode", () => {
  it("binds login-free local mode to loopback", () => {
    expect(resolveRuntimeAuthMode({})).toBe("local");
    expect(nextHostnameArgs({})).toEqual(["-H", "127.0.0.1"]);
  });

  it("keeps Entra mode on the configured host behavior", () => {
    const environment = {
      AUTH_MICROSOFT_ENTRA_ID_ID: "client-id",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret",
    };
    expect(resolveRuntimeAuthMode(environment)).toBe("entra");
    expect(nextHostnameArgs(environment)).toEqual([]);
  });

  it("rejects partial Entra credentials", () => {
    expect(() =>
      nextHostnameArgs({ AUTH_MICROSOFT_ENTRA_ID_ID: "client-id" }),
    ).toThrow("Set both");
  });
});
