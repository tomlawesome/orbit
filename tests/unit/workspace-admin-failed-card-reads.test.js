import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1443: the upload limit, document jobs, key rotation, metadata health and
 * recovery bundle reads are held to the contract #1442 gave the users,
 * contact, relay, services, instance and owners cards.
 *
 * Contract under test (the shape #1442 uses, extended):
 *   - readAdminScreen() gains failed.uploadLimit, failed.operations,
 *     failed.rotation, failed.metadata and failed.recoveryBundle, booleans;
 *   - on a live instance a read that is refused (403), broken (500), never
 *     arrives (network) or is not answered (404) gives the field `null` and
 *     its flag true, never a bare null that reads as "nothing to show";
 *   - an answered read with nothing in it (no rotation open, nothing wrong
 *     with the metadata) is not a failure: flag false;
 *   - a second readAdminScreen() that fails again gives the failed shape
 *     again, and one that succeeds replaces it with the data;
 *   - in fixture mode every flag is false.
 */

const UPLOAD_LIMIT = { effectiveMegabytes: 50, version: 2 };
const ROTATION = { inProgress: true, startedAt: "2026-10-14T09:00:00.000Z", secondKeyLoaded: false };
const METADATA = { locked: 1, damaged: 0 };
const BUNDLE = { exported: true, exportedAt: "2026-10-10T09:00:00.000Z" };
const OPERATIONS = { jobs: [], generatedAt: "2026-10-15T12:00:00.000Z" };
const HOUSEHOLD = { id: "hh-real-1", name: "Real Household", today: "2026-10-15" };

/** @typedef {"ok" | 403 | 500 | "network" | "absent"} Mode */

/**
 * @param {{ live: boolean, modes?: Partial<Record<"uploadLimit" | "operations" | "rotation" | "metadata" | "recoveryBundle", Mode | "empty">, Mode | "empty"> }} opts
 */
function stubFetch({ live, modes = {} }) {
  /** @param {Mode | "empty" | undefined} mode @param {unknown} body */
  const answer = (mode, body) => {
    if (mode === "network") throw new TypeError("Failed to fetch");
    if (mode === "absent") return new Response("{}", { status: 404 });
    if (mode === "empty") return new Response("{}", { status: 200 });
    if (mode === undefined || mode === "ok") return new Response(JSON.stringify(body), { status: 200 });
    return new Response(JSON.stringify({ error: "refused" }), { status: mode });
  };
  const workspace = live
    ? { households: [HOUSEHOLD], activeHouseholdId: HOUSEHOLD.id }
    : { households: [HOUSEHOLD], activeHouseholdId: HOUSEHOLD.id, fixtureToday: "2026-08-13" };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
    }
    if (href.includes("/api/workspace")) return answer("ok", { workspace });
    if (href.includes("/api/admin/upload-limit")) return answer(modes.uploadLimit, { uploadLimit: UPLOAD_LIMIT });
    if (href.includes("/api/admin/documents/rotation")) return answer(modes.rotation, { rotation: ROTATION });
    if (href.includes("/api/admin/documents/health")) return answer(modes.metadata, { health: { metadata: METADATA } });
    if (href.includes("/api/admin/recovery-bundle")) return answer(modes.recoveryBundle, { recoveryBundle: BUNDLE });
    if (href.includes("/api/admin/operations")) return answer(modes.operations, { operations: OPERATIONS });
    if (href.includes("/api/admin/users")) return answer("ok", { users: [] });
    if (href.includes("/members")) return answer("ok", { members: [] });
    return new Response("{}", { status: 404 });
  }));
}

/** @returns {Promise<any>} */
async function readAdmin() {
  const { readAdminScreen } = await import("../../web/src/lib/data/workspace.js");
  return readAdminScreen();
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** [flag/field key, the read's name, the data it returns when it answers] */
const CARDS = /** @type {const} */ ([
  ["uploadLimit", "upload limit", UPLOAD_LIMIT],
  ["operations", "document jobs", OPERATIONS],
  ["rotation", "key rotation", ROTATION],
  ["metadata", "metadata health", METADATA],
  ["recoveryBundle", "recovery bundle", BUNDLE],
]);

const FAILURES = /** @type {const} */ ([
  ["refused (403)", 403],
  ["a server error (500)", 500],
  ["a network error", "network"],
  ["not answered (404)", "absent"],
]);

const ALL_FALSE = { uploadLimit: false, operations: false, rotation: false, metadata: false, recoveryBundle: false };

describe.each(CARDS)("the %s card (%s)", (key, _name, data) => {
  it("answering: the data, not failed", async () => {
    stubFetch({ live: true });
    const view = await readAdmin();
    expect(view[key]).toEqual(data);
    expect(view.failed[key]).toBe(false);
  });

  describe.each(FAILURES)("when the read is %s", (_label, mode) => {
    it("is null and marked failed, and no other card is", async () => {
      stubFetch({ live: true, modes: { [key]: mode } });
      const view = await readAdmin();
      expect(view[key]).toBeNull();
      expect(view.failed[key]).toBe(true);
      for (const other of Object.keys(ALL_FALSE)) {
        if (other !== key) expect(view.failed[other], `${other} flagged by a ${key} failure`).toBe(false);
      }
    });
  });

  it("a retry that fails again publishes the failed shape again", async () => {
    stubFetch({ live: true, modes: { [key]: 500 } });
    const first = await readAdmin();
    expect(first.failed[key]).toBe(true);
    const second = await readAdmin();
    expect(second[key]).toBeNull();
    expect(second.failed[key]).toBe(true);
  });

  it("a retry that succeeds replaces the failed shape with the data", async () => {
    stubFetch({ live: true, modes: { [key]: 500 } });
    const first = await readAdmin();
    expect(first.failed[key]).toBe(true);
    stubFetch({ live: true });
    const second = await readAdmin();
    expect(second[key]).toEqual(data);
    expect(second.failed[key]).toBe(false);
  });

  it("in fixture mode a failed read is not flagged", async () => {
    stubFetch({ live: false, modes: { [key]: 500 } });
    const view = await readAdmin();
    expect(view.failed[key]).toBe(false);
  });
});

describe("answered but empty is not a failure", () => {
  it("no rotation open, nothing wrong with the metadata: null and not failed", async () => {
    stubFetch({ live: true, modes: { rotation: "empty", metadata: "empty" } });
    const view = await readAdmin();
    expect(view.rotation).toBeNull();
    expect(view.failed.rotation).toBe(false);
    expect(view.metadata).toBeNull();
    expect(view.failed.metadata).toBe(false);
  });
});

describe("every card failing at once", () => {
  it("marks all five failed and keeps the earlier flags", async () => {
    stubFetch({ live: true, modes: { uploadLimit: 403, operations: 403, rotation: 403, metadata: 403, recoveryBundle: 403 } });
    const view = await readAdmin();
    expect(view.failed).toMatchObject({ uploadLimit: true, operations: true, rotation: true, metadata: true, recoveryBundle: true });
    expect(view.failed).toHaveProperty("users");
    expect(view.failed).toHaveProperty("contact");
  });
});
