import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { WorkDirectoryError } from "@/lib/work-directory-browser";

const { user, workQuery, listing, preview } = vi.hoisted(() => ({
  user: vi.fn(), workQuery: vi.fn(), listing: vi.fn(), preview: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSessionUserId: user }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { findFirst: workQuery } } }));
vi.mock("@/lib/work-directory-browser", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/work-directory-browser")>(),
  listWorkDirectory: listing, previewWorkFile: preview,
}));

const request = (query = "") => GET(new NextRequest(`http://localhost/api/works/work-1/files${query}`), {
  params: Promise.resolve({ id: "work-1" }),
});
beforeEach(() => {
  vi.resetAllMocks();
  user.mockResolvedValue("owner");
  workQuery.mockResolvedValue({ directoryPath: "C:\\owned\\work" });
  listing.mockResolvedValue({ entries: [], nextOffset: null, total: 0 });
});

describe("owned Work file access", () => {
  it("requires authentication before touching the filesystem or Work data", async () => {
    user.mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    expect(workQuery).not.toHaveBeenCalled();
    expect(listing).not.toHaveBeenCalled();
  });

  it("looks up only a Work owned by the current user and keeps the root server-side", async () => {
    const response = await request("?path=docs&offset=200");
    expect(response.status).toBe(200);
    expect(workQuery).toHaveBeenCalledWith({
      where: { id: "work-1", userId: "owner" }, select: { directoryPath: true },
    });
    expect(listing).toHaveBeenCalledWith("C:\\owned\\work", "docs", 200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not expose another user's Work", async () => {
    workQuery.mockResolvedValue(null);
    expect((await request()).status).toBe(404);
    expect(listing).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each(["?offset=-1", "?offset=no", "?open=0", "?root=C:/outside"])("rejects invalid query %s", async (query) => {
    expect((await request(query)).status).toBe(400);
    expect(listing).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("returns the protected file preview without a write or command execution", async () => {
    preview.mockResolvedValue(new Response("File preview", { headers: { "Content-Type": "text/plain" } }));
    const response = await request("?path=docs%2Fanswer.md&open=1");
    expect(await response.text()).toBe("File preview");
    expect(preview).toHaveBeenCalledWith("C:\\owned\\work", "docs/answer.md");
    expect(listing).not.toHaveBeenCalled();
  });

  it.each([403, 409, 413])("preserves explicit file error status %s", async (status) => {
    listing.mockRejectedValue(new WorkDirectoryError("Explicit file access error", status));
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Explicit file access error" });
  });

  it.each([["ENOENT", 404], ["ENOTDIR", 404], ["EACCES", 403], ["EPERM", 403]])(
    "reports filesystem error %s without exposing its absolute path",
    async (code, status) => {
      listing.mockRejectedValue(Object.assign(new Error("private absolute path"), { code }));
      const response = await request();
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("private absolute path");
    },
  );
});
