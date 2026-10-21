import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The fixture answer of POST /api/households/[householdId]/item-document-inspection
 * must have the shape the engine gives when document reading is off: no
 * message, filename-only (empty) suggestions, attachable.
 */
vi.mock("orbit/server/item-document-inspection", () => ({ inspectItemDocument: vi.fn() }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn() }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: vi.fn(), assertCsrf: vi.fn() }));

describe("item-document-inspection fixture route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers the reading-off shape with no message", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const { POST } = await import("../../web/src/routes/api/households/[householdId]/item-document-inspection/+server.js");
    const response = await POST({
      cookies: { get: () => undefined, set: () => {} },
      params: { householdId: "household-id" },
      request: new Request("http://localhost/x", { method: "POST" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBeUndefined();
    expect(body).toMatchObject({ extracted: false, suggestions: [], attachmentDisposition: "attachable", reason: "supported_structure" });
  });
});
