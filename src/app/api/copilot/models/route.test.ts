import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelCatalog } from "@/lib/copilot-model-catalog";
const mocks = vi.hoisted(() => ({ user: vi.fn(), catalog: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/copilot-models", () => ({ getCopilotModelCatalog: mocks.catalog }));
import { GET } from "./route";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("owner");
  mocks.catalog.mockResolvedValue(buildModelCatalog(["available", "blocked"], [{ id: "available" }]));
});
describe("owner-scoped account model verification API", () => {
  it("authenticates before querying the account", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await GET(new NextRequest("http://localhost/api/copilot/models"))).status).toBe(401);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it("returns verified options with private uncached headers and supports explicit refresh", async () => {
    const response = await GET(new NextRequest("http://localhost/api/copilot/models?refresh=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(await response.json()).toMatchObject({ verified: true, models: ["available"] });
    expect(mocks.catalog).toHaveBeenCalledWith(true);
  });
  it("returns an explicit failure status with unverified choices when lookup fails", async () => {
    mocks.catalog.mockResolvedValue({ ...buildModelCatalog(["known"], null), error: "Could not verify" });
    const response = await GET(new NextRequest("http://localhost/api/copilot/models"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ verified: false, models: ["known"], error: "Could not verify" });
  });
});
