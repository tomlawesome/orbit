import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1593: when Orbit's structure check could not run (the sandbox was stopped
 * or could not start), the three routes that run it answer the engine's own
 * 503 `document_check_unavailable` as it stands -- status, code and the one
 * message, "The file couldn't be uploaded. Please try again." -- with no
 * cache, and never as the 422 for a bad file. A genuine verdict keeps its 422
 * and its words. The engine decides which; these routes must carry it through
 * untouched.
 */
const engine = vi.hoisted(() => ({ inspect: vi.fn(), upload: vi.fn() }));
vi.mock("orbit/server/item-document-inspection", () => ({ inspectItemDocument: engine.inspect }));
vi.mock("orbit/server/document-repository", () => ({
  listItemDocuments: vi.fn(),
  requestDocumentDeletion: vi.fn(),
  uploadItemDocument: engine.upload,
}));
vi.mock("orbit/server/reviewed-intake", () => ({
  authorizeDirectReviewedUpload: vi.fn(),
  completeDirectReviewedUpload: vi.fn(),
  markDirectReviewedUploadRecoverable: vi.fn(async () => {}),
  recordDirectReviewedUploadPending: vi.fn(),
}));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn() }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: vi.fn(), noteRefusedSignIn: vi.fn() }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("orbit/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "member-user" } })),
  assertCsrf: vi.fn(),
}));

const UNAVAILABLE_WORDS = "The file couldn't be uploaded. Please try again.";
const INVALID_WORDS = "Orbit could not open this document. Choose another PDF, JPEG, or PNG.";
const HOUSEHOLD = "5b1f4d3a-9a52-4a36-8d77-0d1c3a4f1111";
const ITEM = "6c2f5e4b-0b63-4b47-9e88-1e2d4b5f2222";
const DOCUMENT = "7d306f5c-1c74-4c58-8f99-2f3e5c6a3333";

const cookies = { get: () => undefined, set: () => {} };
const asEvent = (url, headers, params) => ({
  cookies,
  params,
  route: { id: url },
  request: new Request(`http://localhost${url}`, { method: "POST", headers, body: new Uint8Array([37, 80, 68, 70]) }),
});

const routes = {
  "the check step": async () => {
    const { POST } = await import("../../web/src/routes/api/households/[householdId]/item-document-inspection/+server.js");
    return POST(asEvent("/item-document-inspection", { "x-orbit-filename": "bill.pdf" }, { householdId: HOUSEHOLD }));
  },
  "the staging upload for a new item": async () => {
    const { POST } = await import("../../web/src/routes/api/households/[householdId]/documents/+server.js");
    return POST(asEvent("/documents", {
      "x-orbit-filename": "bill.pdf", "x-orbit-document-id": DOCUMENT, "x-orbit-item-id": ITEM,
    }, { householdId: HOUSEHOLD }));
  },
  "the upload to an existing item": async () => {
    const { POST } = await import("../../web/src/routes/api/households/[householdId]/items/[itemId]/documents/+server.js");
    return POST(asEvent("/items/documents", { "x-orbit-filename": "bill.pdf" }, { householdId: HOUSEHOLD, itemId: ITEM }));
  },
};
const engineFor = { "the check step": engine.inspect, "the staging upload for a new item": engine.upload, "the upload to an existing item": engine.upload };

beforeEach(async () => {
  vi.resetModules();
  engine.inspect.mockReset();
  engine.upload.mockReset();
});

describe.each(Object.entries(routes))("#1593: %s", (name, call) => {
  it("answers 503 document_check_unavailable with the retry message, uncached", async () => {
    const { AppError } = await import("orbit/lib/app-error");
    engineFor[name].mockRejectedValue(new AppError("document_check_unavailable", UNAVAILABLE_WORDS, 503));

    const response = await call();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "document_check_unavailable", message: UNAVAILABLE_WORDS } });
  });

  it("keeps the 422 and its words for an invalid structure", async () => {
    const { AppError } = await import("orbit/lib/app-error");
    engineFor[name].mockRejectedValue(new AppError("document_structure_invalid", INVALID_WORDS, 422));

    const response = await call();

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "document_structure_invalid", message: INVALID_WORDS } });
  });
});
