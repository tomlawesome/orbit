import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1605 G8-FR1: with ORBIT_FIXTURES=1 the inspection route answers the
 * reading-off shape, which the real engine fills with one suggestion: the
 * title read from the file name (buildDocumentSuggestions, source "filename",
 * confidence "high"). The fixture answered an empty list, so dropping a file
 * on the Add item form never pre-filled the title in the demo.
 */
vi.mock("orbit/server/item-document-inspection", () => ({ inspectItemDocument: vi.fn() }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn() }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: vi.fn(), assertCsrf: vi.fn() }));

const post = async (filename) => {
  vi.stubEnv("ORBIT_FIXTURES", "1");
  const { POST } = await import("../../web/src/routes/api/households/[householdId]/item-document-inspection/+server.js");
  const headers = filename === undefined ? {} : { "x-orbit-filename": encodeURIComponent(filename) };
  const response = await POST({
    cookies: { get: () => undefined, set: () => {} },
    params: { householdId: "household-id" },
    request: new Request("http://localhost/x", { method: "POST", headers }),
  });
  return { response, body: await response.json() };
};

describe("fixture item-document-inspection pre-fills the title from the file name", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("suggests the file name without its extension as the title, as the engine does", async () => {
    const { response, body } = await post("Water bill 2026.pdf");
    expect(response.status).toBe(200);
    expect(body.suggestions).toEqual([{ field: "title", value: "Water bill 2026", source: "filename", confidence: "high" }]);
    expect(body).toMatchObject({ extracted: false, attachmentDisposition: "attachable", reason: "supported_structure" });
    expect(body.message).toBeUndefined();
  });

  it("reads the name from the leaf of a path, whatever the separator", async () => {
    const { body } = await post("C:\\scans\\Boiler service.pdf");
    expect(body.suggestions).toEqual([{ field: "title", value: "Boiler service", source: "filename", confidence: "high" }]);
  });
});
