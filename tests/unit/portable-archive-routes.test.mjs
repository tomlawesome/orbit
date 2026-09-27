import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The portable-archive routes' recent-authentication contract (#1132).
 *
 * Writing a household out and bringing an archive in are sensitive acts, so
 * both re-challenge the person in front of the screen (ADR-0023 §5), each for
 * its own intent. Looking inside an archive does not: it reads the uploaded
 * file and nothing the caller cannot already see. Same pattern as
 * tests/unit/admin-systems-route: every collaborator is mocked at its module
 * boundary and the route files run for real, so this proves the wiring and
 * the order of the gate.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  assertCsrf: vi.fn(),
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  requireRecentAuthentication: vi.fn(),
  requirePortableArchiveAccess: vi.fn(),
  createPortableArchive: vi.fn(),
  importPortableArchive: vi.fn(),
  previewPortableImport: vi.fn(),
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
  assertCsrf: mocks.assertCsrf,
}));
vi.mock("orbit/lib/auth/recent-auth", () => ({
  requireRecentAuthentication: mocks.requireRecentAuthentication,
}));
vi.mock("orbit/server/portable-archive-repository", () => ({
  requirePortableArchiveAccess: mocks.requirePortableArchiveAccess,
  createPortableArchive: mocks.createPortableArchive,
  importPortableArchive: mocks.importPortableArchive,
  previewPortableImport: mocks.previewPortableImport,
}));

const HOUSEHOLD = "22222222-2222-4222-8222-222222222222";
const PASSPHRASE = "a-long-enough-passphrase";

/** One request, as SvelteKit hands it to the handler. */
function post(path, body, params = {}) {
  return {
    cookies: { get: () => undefined, set: () => {} },
    params,
    request: new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

/* The routes AND the error classes from one module-registry generation; see
   admin-systems-route.test.mjs for why a copy imported at the top would turn
   every refusal into a 500. */
async function routes() {
  const [exportRoute, importRoute, previewRoute, errors, authErrors] = await Promise.all([
    import("../../web/src/routes/api/households/[householdId]/portable-archives/+server.js"),
    import("../../web/src/routes/api/portable-archives/import/+server.js"),
    import("../../web/src/routes/api/portable-archives/preview/+server.js"),
    import("orbit/lib/errors"),
    import("orbit/lib/auth/errors"),
  ]);
  return {
    exportArchive: exportRoute.POST,
    importArchive: importRoute.POST,
    previewArchive: previewRoute.POST,
    AppError: errors.AppError,
    AuthError: authErrors.AuthError,
  };
}

const exportRequest = (body) => post(`/api/households/${HOUSEHOLD}/portable-archives`, body, { householdId: HOUSEHOLD });
const importRequest = (body) => post("/api/portable-archives/import", body);
const importBody = { householdId: HOUSEHOLD, archive: { ciphertext: "x" }, passphrase: PASSPHRASE, conflictItemIds: [] };

describe("portable archive routes: recent authentication (#1132)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
    mocks.assertCsrf.mockReset();
    mocks.getAuthConfig.mockReset().mockReturnValue({});
    mocks.requireSession.mockReset().mockResolvedValue({
      id: "session-1",
      user: { id: "owner-1", email: "owner@example.com" },
    });
    mocks.requireRecentAuthentication.mockReset().mockImplementation(
      async (_event, _session, _body, intent) => ({ userId: "owner-1", intent, method: "password" }),
    );
    mocks.requirePortableArchiveAccess.mockReset().mockResolvedValue(undefined);
    mocks.createPortableArchive.mockReset().mockResolvedValue({
      id: "archive-1", expiresAt: "2026-09-27T00:00:00.000Z", includesDocuments: false,
    });
    mocks.importPortableArchive.mockReset().mockResolvedValue({ importedItems: 1, documentsExcluded: 0 });
    mocks.previewPortableImport.mockReset().mockResolvedValue({ householdName: "Home", items: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("challenges an export for the archive_export intent, then writes it", async () => {
    const { exportArchive } = await routes();
    const response = await exportArchive(exportRequest({ passphrase: PASSPHRASE, currentPassword: "s3cret" }));

    expect(response.status).toBe(200);
    expect(mocks.requireRecentAuthentication).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ user: expect.objectContaining({ id: "owner-1" }) }),
      expect.objectContaining({ currentPassword: "s3cret" }),
      "archive_export",
    );
    /* The password is the challenge, not part of what the engine is asked to do. */
    expect(mocks.createPortableArchive).toHaveBeenCalledWith({
      userId: "owner-1", householdId: HOUSEHOLD, passphrase: PASSPHRASE, includeDocuments: false,
    });
  });

  it("writes nothing when the exporter cannot prove it is them", async () => {
    const { exportArchive, AuthError } = await routes();
    mocks.requireRecentAuthentication.mockRejectedValue(
      new AuthError("recent_authentication_required", "Confirm it is you before making this change", 403),
    );

    const response = await exportArchive(exportRequest({ passphrase: PASSPHRASE }));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("recent_authentication_required");
    expect(mocks.createPortableArchive).not.toHaveBeenCalled();
  });

  it("refuses somebody who may not export before challenging them", async () => {
    const { exportArchive, AppError } = await routes();
    mocks.requirePortableArchiveAccess.mockRejectedValue(
      new AppError("owner_required", "Only a household owner can make this change", 403),
    );

    const response = await exportArchive(exportRequest({ passphrase: PASSPHRASE }));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("owner_required");
    expect(mocks.requirePortableArchiveAccess).toHaveBeenCalledWith("owner-1", HOUSEHOLD, "export");
    expect(mocks.requireRecentAuthentication).not.toHaveBeenCalled();
    expect(mocks.createPortableArchive).not.toHaveBeenCalled();
  });

  it("challenges an import for the archive_import intent, then brings it in", async () => {
    const { importArchive } = await routes();
    const response = await importArchive(importRequest({ ...importBody, currentPassword: "s3cret" }));

    expect(response.status).toBe(200);
    expect(mocks.requireRecentAuthentication).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ user: expect.objectContaining({ id: "owner-1" }) }),
      expect.objectContaining({ currentPassword: "s3cret" }),
      "archive_import",
    );
    expect(mocks.importPortableArchive).toHaveBeenCalledWith({ userId: "owner-1", ...importBody });
  });

  it("brings nothing in when the importer cannot prove it is them", async () => {
    const { importArchive, AuthError } = await routes();
    mocks.requireRecentAuthentication.mockRejectedValue(
      new AuthError("recent_authentication_required", "Confirm it is you before making this change", 403),
    );

    const response = await importArchive(importRequest(importBody));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("recent_authentication_required");
    expect(mocks.importPortableArchive).not.toHaveBeenCalled();
  });

  it("refuses somebody outside the household before challenging them", async () => {
    const { importArchive, AppError } = await routes();
    mocks.requirePortableArchiveAccess.mockRejectedValue(
      new AppError("household_not_found", "That household is not available", 404),
    );

    const response = await importArchive(importRequest(importBody));

    expect(response.status).toBe(404);
    expect(mocks.requirePortableArchiveAccess).toHaveBeenCalledWith("owner-1", HOUSEHOLD, "import");
    expect(mocks.requireRecentAuthentication).not.toHaveBeenCalled();
    expect(mocks.importPortableArchive).not.toHaveBeenCalled();
  });

  it("does not challenge a preview, which only reads the uploaded file", async () => {
    const { previewArchive } = await routes();
    const response = await previewArchive(post("/api/portable-archives/preview", {
      householdId: HOUSEHOLD, archive: { ciphertext: "x" }, passphrase: PASSPHRASE,
    }));

    expect(response.status).toBe(200);
    expect(mocks.requireRecentAuthentication).not.toHaveBeenCalled();
  });
});
