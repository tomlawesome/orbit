import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1697, review finding: once the four admin reads answer in fixture mode,
 * readAdminScreen() must still give the screen the fidelity gate photographs
 * (#465, §15). In fixture mode `services` and `instance` are exactly what the
 * screen gave when those four reads failed (the admin fixture's rows and
 * strip), and `health` stays null so a tapped row cannot read a different
 * list. `rotation`, `metadata` and `recoveryBundle` come from the answers, as
 * an existing pocket test needs (a route answer of exported:false draws the
 * bundle alert); the canned answers draw no alert, as null did.
 *
 * The "answering" run feeds readAdminScreen() the real route handlers' own
 * fixture answers (every database collaborator throws); the "failing" run
 * answers 500 for the same four URLs.
 *
 * #1792 (L18): the export settings' route (`/api/admin/archive-storage`)
 * joins the "answering" run with its fixture answer, the defaults never
 * changed; the photographed rows stay those of the "failing" run.
 */
const DATABASE_DOWN = new Error("database must not be touched in fixture mode");
vi.mock("orbit/server/authorization", () => ({ requireInstanceAdministrator: async () => { throw DATABASE_DOWN; } }));
vi.mock("orbit/server/admin-health", () => ({ getAdministratorHealth: async () => { throw DATABASE_DOWN; } }));
vi.mock("orbit/server/document-health", () => ({
  getDocumentHealth: async () => { throw DATABASE_DOWN; },
  toPublicDocumentHealth: () => { throw DATABASE_DOWN; },
}));
vi.mock("orbit/server/documents/rotation-status", () => ({ getKekRotationStatus: async () => { throw DATABASE_DOWN; } }));
vi.mock("orbit/server/recovery-bundle-status", () => ({ getRecoveryBundleStatus: async () => { throw DATABASE_DOWN; } }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: async () => undefined }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: () => ({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: async () => { throw DATABASE_DOWN; }, assertCsrf: () => undefined }));

const ROUTE_FILES = {
  "/api/admin/health": "../../web/src/routes/api/admin/health/+server.js",
  "/api/admin/documents/health": "../../web/src/routes/api/admin/documents/health/+server.js",
  "/api/admin/documents/rotation": "../../web/src/routes/api/admin/documents/rotation/+server.js",
  "/api/admin/recovery-bundle": "../../web/src/routes/api/admin/recovery-bundle/+server.js",
  "/api/admin/archive-storage": "../../web/src/routes/api/admin/archive-storage/+server.js",
};
const HOUSEHOLD = { id: "hh-1", name: "Household", today: "2026-08-13" };

/** @param {"answering" | "failing"} mode */
function stubFetch(mode) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = new URL(String(url), "http://localhost").pathname;
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
    }
    if (href.includes("/api/workspace")) {
      return new Response(
        JSON.stringify({ workspace: { households: [HOUSEHOLD], activeHouseholdId: HOUSEHOLD.id, fixtureToday: "2026-08-13" } }),
        { status: 200 },
      );
    }
    if (href in ROUTE_FILES) {
      if (mode === "failing") return new Response(JSON.stringify({ error: "unexpected_failure" }), { status: 500 });
      const { GET } = await import(/* @vite-ignore */ ROUTE_FILES[href]);
      return GET({ cookies: {}, request: new Request(`http://localhost${href}`) });
    }
    if (href.includes("/api/admin/users")) return new Response(JSON.stringify({ users: [] }), { status: 200 });
    if (href.includes("/members")) return new Response(JSON.stringify({ members: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
}

async function screen(mode) {
  vi.resetModules();
  process.env.ORBIT_FIXTURES = "1";
  stubFetch(mode);
  const { readAdminScreen } = await import("../../web/src/lib/data/workspace.js");
  return readAdminScreen();
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORBIT_FIXTURES;
});

describe("administration screen model in fixture mode (#1697)", () => {
  it("keeps the photographed rows, and the canned answers draw no alert", async () => {
    const failing = await screen("failing");
    const answering = await screen("answering");

    // Guard the baseline: the failing run is the pre-#1697 screen.
    expect(failing.services).not.toBeNull();
    expect(failing.instance).toEqual(expect.any(String));

    for (const field of ["services", "instance"]) {
      expect(answering[field], field).toEqual(failing[field]);
    }
    expect(answering.health).toBeNull();
    // What pocket.svelte's alerts read: none of them fires on the canned answers.
    expect(answering.rotation?.inProgress ?? false).toBe(false);
    expect(answering.metadata?.locked ?? false).toBe(false);
    expect(answering.metadata?.damagedValues ?? 0).toBe(0);
    expect(answering.recoveryBundle === null || answering.recoveryBundle.exported).toBe(true);
  });

  it("reads the export settings' fixture answer, the defaults never changed, and the photographed rows do not move (#1792)", async () => {
    const failing = await screen("failing");
    const answering = await screen("answering");
    for (const field of ["services", "instance", "relay", "users", "owners"]) {
      expect(answering[field], field).toEqual(failing[field]);
    }
    expect(answering.archiveStorage).toMatchObject({
      retentionHours: 6,
      keepPerHousehold: 2,
      overrides: { retentionHours: null, keepPerHousehold: null, maxTotalBytes: null },
      version: 1,
      updatedAt: null,
    });
    expect(failing.failed.archiveStorage, "fixture mode flags no card as failed").toBe(false);
  });

  it("flags no card as failed in either run", async () => {
    const answering = await screen("answering");
    expect(Object.values(answering.failed).some(Boolean)).toBe(false);
  });
});
