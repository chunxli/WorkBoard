import { describe, expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { GET } from "./route";
import { config } from "@/proxy";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/auth-mode", () => ({ authMode: "local", isLoopbackHostname: vi.fn() }));

describe("public HTTP health check", () => {
  it("returns an uncached success without an authenticated session", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["/api/health", "/api/health?probe=startup"])(
    "bypasses the authentication proxy for %s", (url) => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
    },
  );

  it.each(["/", "/api/works", "/api/health-records", "/api/health/private"])(
    "preserves proxy protection for %s", (url) => {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    },
  );
});
