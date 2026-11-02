import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1411: the page Content-Security-Policy (kit.csp) is for PAGES. The routes
 * that hand out a document's bytes keep their own, stricter policy, a null one
 * with a sandbox: `default-src 'none'; sandbox`. Kit applies kit.csp to page
 * responses only and never to +server responses, so these stay as they are; this
 * pins that, whatever the page policy becomes.
 *
 * Why a unit test and not a request to the built app: a preview or a download
 * needs a signed-in session and a stored document, which the integration
 * harness's shim test (tests/integration/page-csp.test.ts) does not have. The
 * response builders are covered here, and the built app's /api/ answers are
 * covered there.
 *
 * Covered: previewResponse and placeholderResponse in
 * web/src/lib/server/preview-response.js (which every page-preview route uses),
 * and the download route's own response, real and fixture.
 */
const NULL_CSP = "default-src 'none'; sandbox";
const DOCUMENT = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  openDocumentDownload: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: mocks.requireSession, assertCsrf: vi.fn() }));
vi.mock("orbit/server/document-repository", () => ({ openDocumentDownload: mocks.openDocumentDownload }));

describe("document previews and downloads keep `default-src 'none'; sandbox` (#1411)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset().mockResolvedValue({ id: "s1", user: { id: "u1" } });
  });

  it("previewResponse: the drawn page of a document", async () => {
    const { previewResponse } = await import("../../web/src/lib/server/preview-response.js");
    const response = previewResponse({ bytes: Buffer.from([137, 80, 78, 71]), mediaType: "image/png", pageCount: 2 });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(NULL_CSP);
  });

  it("placeholderResponse: the fixture harness's page, under the same policy", async () => {
    const { placeholderResponse } = await import("../../web/src/lib/server/preview-response.js");
    const response = placeholderResponse("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(NULL_CSP);
  });

  it("the download route: the document's bytes as a file", async () => {
    mocks.openDocumentDownload.mockResolvedValue({
      body: new Response(new Uint8Array([1, 2, 3])).body,
      displayName: "bill.pdf",
      sizeBytes: 3,
    });
    const { GET } = await import("../../web/src/routes/api/documents/[documentId]/download/+server.js");
    const response = await GET({
      cookies: { get: () => undefined, set: () => {} },
      params: { documentId: DOCUMENT },
      url: new URL(`http://localhost/api/documents/${DOCUMENT}/download`),
      request: new Request(`http://localhost/api/documents/${DOCUMENT}/download`),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(NULL_CSP);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
  });
});
