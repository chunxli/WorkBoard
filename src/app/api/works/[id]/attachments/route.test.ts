import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@/lib/work-attachment-types";

const mocks = vi.hoisted(() => ({ user: vi.fn(), work: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUserId: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { work: { findFirst: mocks.work } } }));
import { GET, POST } from "./route";

describe("owner-scoped Work attachment routes", () => {
  let directoryPath: string;
  let work: { id: string; directoryPath: string; status: string; hostname: string };
  const params = { params: Promise.resolve({ id: "work-attachment-route" }) };
  beforeEach(async () => {
    vi.clearAllMocks();
    directoryPath = await mkdtemp(path.join(tmpdir(), "workboard-attachment-route-"));
    work = { id: "work-attachment-route", directoryPath, status: "ACTIVE", hostname: hostname() };
    mocks.user.mockResolvedValue("owner"); mocks.work.mockResolvedValue(work);
  });
  afterEach(async () => { await rm(directoryPath, { recursive: true, force: true }); });
  function upload(bytes = Buffer.from("synthetic file"), overrides: Record<string, string> = {}, headers?: Record<string, string>) {
    const query = new URLSearchParams({ requestId: randomUUID(), uploadId: randomUUID(), name: "report.html", size: String(bytes.length), ...overrides });
    return POST(new NextRequest(`http://localhost/api/works/${work.id}/attachments?${query}`, {
      method: "POST", body: bytes, headers: { "Content-Type": "application/octet-stream", Origin: "http://localhost", ...headers },
    }), params);
  }
  async function view(reference: { id: string; requestId: string }, download = false) {
    return GET(new NextRequest(`http://localhost/api/works/${work.id}/attachments?${new URLSearchParams({
      requestId: reference.requestId, attachmentId: reference.id, ...(download ? { download: "1" } : {}),
    })}`), params);
  }
  it("requires authentication, ownership, local host, and same-origin binary uploads", async () => {
    mocks.user.mockResolvedValueOnce(null); expect((await upload()).status).toBe(401);
    mocks.work.mockResolvedValueOnce(null); expect((await upload()).status).toBe(404);
    mocks.work.mockResolvedValueOnce({ ...work, hostname: "other-host" }); expect((await upload()).status).toBe(409);
    mocks.work.mockResolvedValueOnce({ ...work, status: "ARCHIVED" }); expect((await upload()).status).toBe(409);
    expect((await upload(undefined, {}, { Origin: "https://untrusted.example" })).status).toBe(403);
    expect((await upload(undefined, {}, { "Content-Type": "text/plain" })).status).toBe(403);
    expect(mocks.work).toHaveBeenCalledWith(expect.objectContaining({ where: { id: work.id, userId: "owner" } }));
  });
  it("validates identities and declared limits before accepting bytes", async () => {
    expect((await upload(undefined, { requestId: "../escape" })).status).toBe(400);
    expect((await upload(undefined, { name: "../escape" })).status).toBe(400);
    expect((await upload(undefined, { size: String(MAX_ATTACHMENT_BYTES + 1) })).status).toBe(413);
    expect((await upload(undefined, { size: "999" })).status).toBe(409);
  });
  it("uses the browser Host for origin checks when Next normalizes its internal URL to localhost", async () => {
    expect((await upload(undefined, {}, { Host: "127.0.0.1:3122", Origin: "http://127.0.0.1:3122" })).status).toBe(201);
    expect((await upload(undefined, {}, { Host: "127.0.0.1:3122", Origin: "http://localhost:3122" })).status).toBe(403);
    expect((await upload(undefined, {}, { Host: "127.0.0.1:3122", Origin: "http://127.0.0.1:3100" })).status).toBe(403);
  });
  it("returns stable receipts, isolates references, and downloads arbitrary HTML without execution", async () => {
    const request = { requestId: randomUUID(), uploadId: randomUUID() };
    const bytes = Buffer.from("<script>alert('synthetic')</script>");
    const first = await upload(bytes, request);
    const { attachment } = await first.json();
    expect(first.status).toBe(201);
    expect(await (await upload(bytes, request)).json()).toEqual({ attachment });
    const response = await view(attachment);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect((await view({ ...attachment, id: randomUUID() })).status).toBe(404);
    await writeFile(path.join(directoryPath, ".workboard", "attachments", work.id, attachment.requestId, attachment.storedName), "modified");
    expect((await view(attachment)).status).toBe(409);
  });
  it("inlines only sniffed raster files and supports explicit downloads", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const { attachment } = await (await upload(png, { name: "image.png" })).json();
    const response = await view(attachment);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect((await view(attachment, true)).headers.get("Content-Disposition")).toMatch(/^attachment;/);
    mocks.user.mockResolvedValueOnce(null); expect((await view(attachment)).status).toBe(401);
    mocks.work.mockResolvedValueOnce(null); expect((await view(attachment)).status).toBe(404);
  });
});
