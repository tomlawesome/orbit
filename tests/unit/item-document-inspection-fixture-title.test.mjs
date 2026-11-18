import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1789 G8-FR1: the fixture answer of POST .../item-document-inspection gives
 * `suggestions: []`, but the engine, with document reading off, still returns
 * the filename's title (buildDocumentSuggestions adds `title` from the file
 * name, source "filename"). The demo harness shows the create form's reading
 * lane with nothing to offer for a dropped file; it should offer the title.
 */
vi.mock("orbit/server/item-document-inspection", () => ({ inspectItemDocument: vi.fn() }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn() }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: vi.fn(), assertCsrf: vi.fn() }));

describe("item-document-inspection fixture route offers the dropped file's title (#1789 G8-FR1)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a file named Service history.pdf gets a title suggestion from its name", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const { POST } = await import("../../web/src/routes/api/households/[householdId]/item-document-inspection/+server.js");
    const response = await POST({
      cookies: { get: () => undefined, set: () => {} },
      params: { householdId: "household-id" },
      request: new Request("http://localhost/x", {
        method: "POST",
        headers: { "x-orbit-filename": encodeURIComponent("Service history.pdf") },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.attachmentDisposition).toBe("attachable");
    const title = body.suggestions.find((/** @type {{ field: string }} */ suggestion) => suggestion.field === "title");
    expect(title, "a title suggestion").toBeDefined();
    expect(title.value).toMatch(/service history/i);
    expect(title.source).toBe("filename");
  });
});
