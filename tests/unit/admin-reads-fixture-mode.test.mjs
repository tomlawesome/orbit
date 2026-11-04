import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1697: with ORBIT_FIXTURES=1 and no database, the four administration reads
 * that /administration makes on load answer a canned, realistic body, as
 * /api/admin/users does, instead of querying the database and answering 500.
 * Every database-touching collaborator is a stub that throws, so a route that
 * reaches any of them fails loudly. "Realistic" means the shape of the real
 * answer, field for field, as web/src/lib/data/workspace.js reads it.
 */
const DATABASE_DOWN = new Error("database must not be touched in fixture mode");
const mocks = vi.hoisted(() => ({
  requireInstanceAdministrator: vi.fn(),
  getAdministratorHealth: vi.fn(),
  getDocumentHealth: vi.fn(),
  toPublicDocumentHealth: vi.fn(),
  getKekRotationStatus: vi.fn(),
  getRecoveryBundleStatus: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
}));

vi.mock("orbit/server/authorization", () => ({ requireInstanceAdministrator: mocks.requireInstanceAdministrator }));
vi.mock("orbit/server/admin-health", () => ({ getAdministratorHealth: mocks.getAdministratorHealth }));
vi.mock("orbit/server/document-health", () => ({
  getDocumentHealth: mocks.getDocumentHealth,
  toPublicDocumentHealth: mocks.toPublicDocumentHealth,
}));
vi.mock("orbit/server/documents/rotation-status", () => ({ getKekRotationStatus: mocks.getKekRotationStatus }));
vi.mock("orbit/server/recovery-bundle-status", () => ({ getRecoveryBundleStatus: mocks.getRecoveryBundleStatus }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: () => ({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: mocks.requireSession, assertCsrf: vi.fn() }));

const ROUTES = {
  health: "../../web/src/routes/api/admin/health/+server.js",
  documentsHealth: "../../web/src/routes/api/admin/documents/health/+server.js",
  rotation: "../../web/src/routes/api/admin/documents/rotation/+server.js",
  recoveryBundle: "../../web/src/routes/api/admin/recovery-bundle/+server.js",
};

const event = (path) => ({ cookies: {}, request: new Request(`http://localhost${path}`) });

async function answer(route, path) {
  const { GET } = await import(/* @vite-ignore */ ROUTES[route]);
  const response = await GET(event(path));
  return { response, body: await response.json() };
}

function expectNoDatabase() {
  expect(mocks.requireInstanceAdministrator).not.toHaveBeenCalled();
  expect(mocks.getAdministratorHealth).not.toHaveBeenCalled();
  expect(mocks.getDocumentHealth).not.toHaveBeenCalled();
  expect(mocks.getKekRotationStatus).not.toHaveBeenCalled();
  expect(mocks.getRecoveryBundleStatus).not.toHaveBeenCalled();
}

describe("admin reads in fixture mode (#1697)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ORBIT_FIXTURES = "1";
    for (const name of [
      "requireInstanceAdministrator",
      "getAdministratorHealth",
      "getDocumentHealth",
      "toPublicDocumentHealth",
      "getKekRotationStatus",
      "getRecoveryBundleStatus",
      "requireSession",
    ]) {
      mocks[name].mockReset().mockRejectedValue(DATABASE_DOWN);
    }
    mocks.toPublicDocumentHealth.mockReset().mockImplementation(() => {
      throw DATABASE_DOWN;
    });
    mocks.assertOutsideMaintenance.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ORBIT_FIXTURES;
  });

  it("GET /api/admin/health answers the build stamp and the five service rows", async () => {
    const { response, body } = await answer("health", "/api/admin/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.health.build).toEqual({
      version: expect.any(String),
      channel: expect.any(String),
      revision: expect.any(String),
    });
    expect(body.health.services.map((service) => service.id)).toEqual([
      "database",
      "notification-worker",
      "mailbox-ingestion",
      "virus-scanner",
      "document-parser",
    ]);
    for (const service of body.health.services) {
      expect(["ok", "warn", "down", "off"]).toContain(service.state);
      expect(Number.isNaN(Date.parse(service.checkedAt))).toBe(false);
    }
    expectNoDatabase();
  });

  it("GET /api/admin/documents/health answers the public document health with metadata counts", async () => {
    const { response, body } = await answer("documentsHealth", "/api/admin/documents/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body.health).sort()).toEqual(
      ["encryption", "metadata", "modelExtraction", "overall", "quota", "scanRecovery", "scanner", "storage", "worker"],
    );
    expect(body.health.metadata).toEqual({
      locked: false,
      lockedItems: 0,
      lockedReceipts: 0,
      damagedValues: 0,
      damagedItems: 0,
      damagedReceipts: 0,
    });
    expect(body.health.quota).toEqual({ usedBytes: expect.any(Number), limitBytes: expect.any(Number) });
    expect(body.health.worker).toHaveProperty("running");
    expectNoDatabase();
  });

  it("GET /api/admin/documents/rotation answers that no rotation is open", async () => {
    const { response, body } = await answer("rotation", "/api/admin/documents/rotation");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ rotation: { inProgress: false, startedAt: null, secondKeyLoaded: false } });
    expectNoDatabase();
  });

  it("GET /api/admin/recovery-bundle answers a recorded export, so no nag card is drawn", async () => {
    const { response, body } = await answer("recoveryBundle", "/api/admin/recovery-bundle");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.recoveryBundle.exported).toBe(true);
    expect(Number.isNaN(Date.parse(body.recoveryBundle.exportedAt))).toBe(false);
    expectNoDatabase();
  });

  it("does not answer from the fixture when ORBIT_FIXTURES is not 1 (the real handler runs)", async () => {
    process.env.ORBIT_FIXTURES = "0";
    mocks.requireSession.mockReset().mockResolvedValue({ user: { id: "u-1" } });
    mocks.requireInstanceAdministrator.mockReset().mockResolvedValue(undefined);
    mocks.getKekRotationStatus.mockReset().mockResolvedValue({ inProgress: true, startedAt: null, secondKeyLoaded: true });
    const { body } = await answer("rotation", "/api/admin/documents/rotation");
    expect(body.rotation.inProgress).toBe(true);
    expect(mocks.requireInstanceAdministrator).toHaveBeenCalled();
  });
});
