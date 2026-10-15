import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * GET /api/portable-archives/[archiveId]/download streams the stored file
 * (#1428, part of #1316): the route asks the repository to open the download
 * and answers with that stream as the body and its size as Content-Length. It
 * never reads the whole archive into memory. Same pattern as
 * tests/unit/portable-archive-routes.test.mjs: every collaborator is mocked at
 * its module boundary and the route file runs for real.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertCsrf: vi.fn(),
  openPortableArchiveDownload: vi.fn(),
  readPortableArchive: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
  assertCsrf: mocks.assertCsrf,
}));
vi.mock("orbit/server/portable-archive-repository", () => ({
  openPortableArchiveDownload: mocks.openPortableArchiveDownload,
  readPortableArchive: mocks.readPortableArchive,
}));

const ARCHIVE = "33333333-3333-4333-8333-333333333333";
const CONTENT = new TextEncoder().encode(JSON.stringify({ format: "orbit-portable-archive", ciphertext: "abc123" }));

function get() {
  return {
    cookies: { get: () => undefined, set: () => {} },
    params: { archiveId: ARCHIVE },
    request: new Request(`http://localhost/api/portable-archives/${ARCHIVE}/download`, { method: "GET" }),
  };
}

/* The route AND the error class from one module-registry generation; see
   admin-systems-route.test.mjs for why a copy imported at the top would turn
   every refusal into a 500. */
async function route() {
  const [module, errors] = await Promise.all([
    import("../../web/src/routes/api/portable-archives/[archiveId]/download/+server.js"),
    import("orbit/lib/errors"),
  ]);
  return { GET: module.GET, AppError: errors.AppError };
}

/** A stream that hands the known bytes over in several small chunks. */
function streamOf(bytes, chunkSize = 16) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

describe("portable archive download route: streams the stored file (#1428)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.assertCsrf.mockReset();
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset().mockResolvedValue({
      id: "session-1",
      user: { id: "owner-1", email: "owner@example.com" },
    });
    mocks.openPortableArchiveDownload.mockReset().mockImplementation(async () => ({
      stream: streamOf(CONTENT),
      sizeBytes: CONTENT.length,
    }));
    mocks.readPortableArchive.mockReset().mockRejectedValue(new Error("the whole archive must not be read into memory"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 200 with the stream's bytes, Content-Length equal to sizeBytes, and the unchanged headers", async () => {
    const { GET } = await route();
    const response = await GET(get());

    expect(response.status).toBe(200);
    expect(mocks.openPortableArchiveDownload).toHaveBeenCalledWith("owner-1", ARCHIVE);
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(CONTENT))).toBe(true);
    expect(response.headers.get("content-length")).toBe(String(CONTENT.length));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/u);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never reads the whole archive into memory", async () => {
    const { GET } = await route();
    const response = await GET(get());
    await response.arrayBuffer();

    expect(mocks.readPortableArchive).not.toHaveBeenCalled();
  });

  it("passes the repository's refusal through with its status and code, sending no body from the archive", async () => {
    const { GET, AppError } = await route();
    mocks.openPortableArchiveDownload.mockRejectedValue(
      new AppError("archive_integrity_failed", "That archive could not be verified", 503),
    );

    const response = await GET(get());

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("archive_integrity_failed");
  });
});
