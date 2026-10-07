import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1300: the `page` query parameter and the `X-Orbit-Page-Count` header on
 * the two GET preview routes -- an accepted document's
 * (/api/documents/[documentId]/preview) and a staged mail-in attachment's
 * (/api/imap-inbox/[receiptId]/attachments/[attachmentId]/preview). Same
 * pattern as item-document-preview-route.test.mjs: every collaborator is
 * mocked at its module boundary and the route files run for real. The
 * renderer's own page handling (page N drawn, past the end refused after the
 * existing checks, an image is one page) is proven against real bytes in
 * src/server/documents/preview.test.ts.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  readDocumentPagePreview: vi.fn(),
  readHeldImapAttachmentPreview: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: mocks.requireSession, assertCsrf: vi.fn() }));
vi.mock("orbit/server/document-preview", () => ({ readDocumentPagePreview: mocks.readDocumentPagePreview }));
vi.mock("orbit/server/mail-in/imap-attachment-preview", () => ({
  readHeldImapAttachmentPreview: mocks.readHeldImapAttachmentPreview,
}));

const DOCUMENT = "33333333-3333-4333-8333-333333333333";
const RECEIPT = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT = "55555555-5555-4555-8555-555555555555";

/** @param {string} path @param {Record<string, string>} params */
function event(path, params) {
  return {
    cookies: { get: () => undefined, set: () => {} },
    params,
    url: new URL(`http://localhost${path}`),
    request: new Request(`http://localhost${path}`),
  };
}

/* The routes AND the error class from one module-registry generation; see
   admin-systems-route.test.mjs for why a copy imported at the top would turn
   every refusal into a 500. */
async function routes() {
  const [stored, staged, errors] = await Promise.all([
    import("../../web/src/routes/api/documents/[documentId]/preview/+server.js"),
    import("../../web/src/routes/api/imap-inbox/[receiptId]/attachments/[attachmentId]/preview/+server.js"),
    import("orbit/lib/app-error"),
  ]);
  return { stored: stored.GET, staged: staged.GET, AppError: errors.AppError };
}

const drawn = () => ({ bytes: Buffer.from([137, 80, 78, 71]), mediaType: "image/png", width: 1, height: 1, pageCount: 3 });

const storedEvent = (query = "") => event(`/api/documents/${DOCUMENT}/preview${query}`, { documentId: DOCUMENT });
const stagedEvent = (query = "") => event(
  `/api/imap-inbox/${RECEIPT}/attachments/${ATTACHMENT}/preview${query}`,
  { receiptId: RECEIPT, attachmentId: ATTACHMENT },
);

describe("preview routes: ?page=N and X-Orbit-Page-Count (#1300)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset().mockResolvedValue({ id: "s1", user: { id: "u1" } });
    mocks.readDocumentPagePreview.mockReset().mockImplementation(async () => drawn());
    mocks.readHeldImapAttachmentPreview.mockReset().mockImplementation(async () => drawn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("draws page one when no page is asked for, and carries the page count", async () => {
    const { stored, staged } = await routes();

    const one = await stored(storedEvent());
    expect(one.status).toBe(200);
    expect(one.headers.get("x-orbit-page-count")).toBe("3");
    expect(mocks.readDocumentPagePreview).toHaveBeenCalledWith("u1", DOCUMENT, 1);

    const two = await staged(stagedEvent());
    expect(two.status).toBe(200);
    expect(two.headers.get("x-orbit-page-count")).toBe("3");
    expect(mocks.readHeldImapAttachmentPreview).toHaveBeenCalledWith("u1", RECEIPT, ATTACHMENT, 1);
  });

  it("draws the page asked for, under the same private headers", async () => {
    const { stored, staged } = await routes();

    const response = await stored(storedEvent("?page=3"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(mocks.readDocumentPagePreview).toHaveBeenCalledWith("u1", DOCUMENT, 3);

    await staged(stagedEvent("?page=2"));
    expect(mocks.readHeldImapAttachmentPreview).toHaveBeenCalledWith("u1", RECEIPT, ATTACHMENT, 2);
  });

  it.each(["?page=0", "?page=-1", "?page=1.5", "?page=two", "?page=", "?page=1001"])(
    "refuses %s with a 400 before the document is read",
    async (query) => {
      const { stored, staged } = await routes();

      for (const response of [await stored(storedEvent(query)), await staged(stagedEvent(query))]) {
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect((await response.json()).error.code).toBe("document_preview_page_invalid");
      }
      expect(mocks.readDocumentPagePreview).not.toHaveBeenCalled();
      expect(mocks.readHeldImapAttachmentPreview).not.toHaveBeenCalled();
    },
  );

  it("answers a page past the end as the renderer words it, never as a picture", async () => {
    const { stored, AppError } = await routes();
    mocks.readDocumentPagePreview.mockRejectedValue(
      new AppError("document_preview_page_not_found", "That page is past the end of this document", 404),
    );

    const response = await stored(storedEvent("?page=4"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "document_preview_page_not_found", message: "That page is past the end of this document" },
    });
  });

  it("answers the fixture harness's placeholder as one page, and refuses a second", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const { stored } = await routes();
    const { DOCUMENTS_FIXTURE } = await import("../../web/src/lib/data/fixtures/workspace.js");
    const fixtureId = Object.values(DOCUMENTS_FIXTURE).flat()[0]?.id;
    expect(fixtureId).toBeTruthy();
    const fixtureEvent = (query = "") => event(`/api/documents/${fixtureId}/preview${query}`, { documentId: fixtureId });

    const one = await stored(fixtureEvent());
    expect(one.status).toBe(200);
    expect(one.headers.get("x-orbit-page-count")).toBe("1");
    const two = await stored(fixtureEvent("?page=2"));
    expect(two.status).toBe(404);
    expect((await two.json()).error.code).toBe("document_preview_page_not_found");
    expect(mocks.readDocumentPagePreview).not.toHaveBeenCalled();
  });
});
