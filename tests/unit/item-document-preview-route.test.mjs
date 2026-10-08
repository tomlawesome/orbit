import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * POST /api/households/[householdId]/item-document-preview's answer
 * (ADR-0033 step 5): the create form's reading card says the virus check is
 * under way, then that Orbit has moved on to the preview. So the route
 * answers NDJSON -- the scan's line the moment the scan passes, then the
 * picture's line or an error line -- while anything refused before the scan
 * finished stays the ordinary JSON error with its status. Same pattern as
 * tests/unit/system-status-route.test.mjs: every collaborator is mocked at
 * its module boundary and the route file runs for real.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  previewItemDocument: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: mocks.requireSession, assertCsrf: vi.fn() }));
vi.mock("orbit/server/item-document-preview", () => ({ previewItemDocument: mocks.previewItemDocument }));

const HOUSEHOLD = "22222222-2222-4222-8222-222222222222";

function event(headers = { "x-orbit-filename": "my%20policy.pdf", "x-orbit-declared-bytes": "4" }) {
  return {
    cookies: { get: () => undefined, set: () => {} },
    params: { householdId: HOUSEHOLD },
    request: new Request(`http://localhost/api/households/${HOUSEHOLD}/item-document-preview`, {
      method: "POST",
      headers: { "content-type": "application/pdf", ...headers },
      body: new Uint8Array([37, 80, 68, 70]),
    }),
  };
}

/* The route AND the error class from one module-registry generation; see
   admin-systems-route.test.mjs for why a copy imported at the top would turn
   every refusal into a 500. */
async function route() {
  const [module, errors] = await Promise.all([
    import("../../web/src/routes/api/households/[householdId]/item-document-preview/+server.js"),
    import("orbit/lib/app-error"),
  ]);
  return { POST: module.POST, AppError: errors.AppError };
}

/** @param {Response} response */
async function lines(response) {
  return (await response.text()).split("\n").filter(Boolean).map((text) => JSON.parse(text));
}

describe("item-document-preview route: stages as NDJSON (ADR-0033 step 5)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset().mockResolvedValue({ id: "s1", user: { id: "u1" } });
    mocks.previewItemDocument.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers a refusal before the scan finished as the ordinary JSON error with its status", async () => {
    const { POST, AppError } = await route();
    mocks.previewItemDocument.mockRejectedValue(
      new AppError("document_malware_detected", "Orbit rejected that document because malware was detected", 422),
    );
    const response = await POST(event());

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
    expect(await response.json()).toEqual({
      error: { code: "document_malware_detected", message: "Orbit rejected that document because malware was detected" },
    });
  });

  it("refuses a missing filename as JSON before anything is previewed", async () => {
    const { POST } = await route();
    const response = await POST(event({}));

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("document_filename_required");
    expect(mocks.previewItemDocument).not.toHaveBeenCalled();
  });

  it("writes the scan's line, then the picture's, and zeroes the server's copy", async () => {
    const { POST } = await route();
    const bytes = Buffer.from([137, 80, 78, 71]);
    mocks.previewItemDocument.mockImplementation(async (input) => {
      input.onScanned(true);
      return { bytes, mediaType: "image/png", width: 1, height: 1, scanned: true };
    });
    const response = await POST(event());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("x-orbit-scan")).toBe(false);
    expect(await lines(response)).toEqual([
      { stage: "scanned", scanned: true },
      { stage: "preview", mediaType: "image/png", bytes: Buffer.from([137, 80, 78, 71]).toString("base64") },
    ]);
    expect([...bytes]).toEqual([0, 0, 0, 0]);
    expect(mocks.previewItemDocument).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1", householdId: HOUSEHOLD, declaredBytes: 4,
    }));
  });

  it("sends the scan's line before the picture has been drawn", async () => {
    const { POST } = await route();
    /** @type {(value: unknown) => void} */
    let finish = () => {};
    mocks.previewItemDocument.mockImplementation((input) => new Promise((resolve) => {
      input.onScanned(false);
      finish = resolve;
    }));
    const response = await POST(event());
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const first = await reader.read();

    expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ stage: "scanned", scanned: false });
    finish({ bytes: Buffer.from([1]), mediaType: "image/jpeg", width: 1, height: 1, scanned: false });
    const second = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(second.value))).toMatchObject({ stage: "preview", mediaType: "image/jpeg" });
  });

  it("turns an AppError after the scan into an error line in its own words", async () => {
    const { POST, AppError } = await route();
    mocks.previewItemDocument.mockImplementation(async (input) => {
      input.onScanned(true);
      throw new AppError("document_preview_failed", "Orbit could not draw that document", 422);
    });
    const response = await POST(event());

    expect(response.status).toBe(200);
    expect(await lines(response)).toEqual([
      { stage: "scanned", scanned: true },
      { error: { code: "document_preview_failed", message: "Orbit could not draw that document" } },
    ]);
  });

  it("never writes internal error text on an error line", async () => {
    const { POST } = await route();
    mocks.previewItemDocument.mockImplementation(async (input) => {
      input.onScanned(true);
      throw new Error("pdf.js exploded at /srv/orbit/secret/path");
    });
    const response = await POST(event());
    const answer = await lines(response);

    expect(answer[1]).toEqual({ error: { code: "internal_error", message: "Orbit could not complete the request" } });
    expect(JSON.stringify(answer)).not.toMatch(/exploded|secret/u);
  });

  it("answers the fixture harness in the same shape: not scanned, then the placeholder page", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const { POST } = await route();
    const response = await POST(event());
    const answer = await lines(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.has("x-orbit-scan")).toBe(false);
    expect(answer[0]).toEqual({ stage: "scanned", scanned: false });
    expect(answer[1].stage).toBe("preview");
    expect(answer[1].mediaType).toBe("image/svg+xml");
    expect(Buffer.from(answer[1].bytes, "base64").toString("utf8")).toMatch(/^<svg[\s\S]*my policy\.pdf/u);
    expect(mocks.previewItemDocument).not.toHaveBeenCalled();
  });
});
