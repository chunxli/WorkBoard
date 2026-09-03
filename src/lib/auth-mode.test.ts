import { describe, expect, it } from "vitest";
import { isLoopbackHostname, resolveAuthMode } from "./auth-mode";

describe("authentication mode", () => {
  it("uses local mode only when both Entra credentials are absent", () => {
    expect(resolveAuthMode({})).toBe("local");
    expect(resolveAuthMode({
      AUTH_MICROSOFT_ENTRA_ID_ID: "client-id",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret",
    })).toBe("entra");
  });

  it("fails closed when the Entra configuration is partial", () => {
    expect(() => resolveAuthMode({ AUTH_MICROSOFT_ENTRA_ID_ID: "client-id" }))
      .toThrow("Set both");
    expect(() => resolveAuthMode({ AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret" }))
      .toThrow("Set both");
  });

  it("recognizes loopback hosts without accepting remote hosts", () => {
    for (const host of ["localhost", "localhost:3100", "127.0.0.1:3100", "[::1]:3100", "::1"]) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
    for (const host of [null, "workboard.example.com", "10.0.0.5:3100", "localhost.example.com"]) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
});