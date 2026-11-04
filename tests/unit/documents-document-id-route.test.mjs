import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `DELETE /api/documents/[documentId]` (soft delete) and
 * `POST /api/documents/[documentId]/restore` (undo), #735 port. Both are
 * `write()` routes: maintenance guard, session, real CSRF. The acting user is
 * always the session's; the document id comes from the path. The repository
 * enforces household membership, so its refusals (404 for a document the
 * caller cannot see, 403) must reach the client unchanged. no-store.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  requestDocumentDeletion: vi.fn(),
  restoreDocument: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/document-repository", () => ({
  requestDocumentDeletion: mocks.requestDocumentDeletion,
  restoreDocument: mocks.restoreDocument,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { DELETE } = await import("../../web/src/routes/api/documents/[documentId]/+server.js");
const { POST: RESTORE } = await import("../../web/src/routes/api/documents/[documentId]/restore/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "u-1" } };
const document = { id: "doc-1", status: "deleted" };

function event(method, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: {},
    params: { documentId: "doc-1" },
    request: new Request("https://orbit.example/api/documents/doc-1", { method, headers }),
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.requestDocumentDeletion.mockResolvedValue(document);
  mocks.restoreDocument.mockResolvedValue({ ...document, status: "active" });
});

describe.each([
  ["DELETE /api/documents/[documentId]", DELETE, "DELETE", () => mocks.requestDocumentDeletion],
  ["POST /api/documents/[documentId]/restore", RESTORE, "POST", () => mocks.restoreDocument],
])("%s", (_name, handler, method, action) => {
  it("acts as the session's user on the path's document and answers no-store JSON", async () => {
    const response = await handler(event(method));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")?.toLowerCase()).toBe("no-store");
    expect((await response.json()).document.id).toBe("doc-1");
    expect(action()).toHaveBeenCalledWith("u-1", "doc-1");
  });

  it("refuses a signed-out caller with 401", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "x", 401));
    expect((await handler(event(method))).status).toBe(401);
    expect(action()).not.toHaveBeenCalled();
  });

  it("refuses a missing CSRF token, a wrong one and a cross-origin request", async () => {
    expect((await handler(event(method, { csrf: "" }))).status).toBe(403);
    expect((await handler(event(method, { csrf: "forged" }))).status).toBe(403);
    expect((await handler(event(method, { origin: "https://evil.example" }))).status).toBe(403);
    expect(action()).not.toHaveBeenCalled();
  });

  it("answers 503 during maintenance", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    expect((await handler(event(method))).status).toBe(503);
    expect(action()).not.toHaveBeenCalled();
  });

  it("passes the repository's refusal for another household's document through (404 and 403)", async () => {
    action().mockRejectedValueOnce(new AppError("document_not_found", "No such document", 404));
    const missing = await handler(event(method));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("document_not_found");
    action().mockRejectedValueOnce(new AppError("forbidden", "Not a member", 403));
    expect((await handler(event(method))).status).toBe(403);
  });
});
