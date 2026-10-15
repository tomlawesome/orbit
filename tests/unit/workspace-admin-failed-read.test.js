import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFixture } from "../../web/src/lib/data/fixtures/admin.js";

/*
 * #1442: a failed administration read on a live instance shows no mockup values.
 *
 * `readAdminScreen()` used to fall back to the made-up rows in
 * web/src/lib/data/fixtures/admin.js whenever a read was refused (403), broke
 * (5xx) or never arrived (network error): an ordinary member who opened
 * /administration saw "collection domain in.harlow-home.orbit" as though it were
 * theirs. Fixtures belong to fixture mode only (the fixture workspace carries
 * `fixtureToday`; a live one never does).
 *
 * Contract under test (the shape the builder implements):
 *   - the result gains `failed`: { relay, services, instance, owners }, each a
 *     boolean, true when that panel's read did not answer;
 *   - a failed `relay`, `services` or `instance` is `null`;
 *   - `owners` is always a plain name map built only from members reads that
 *     answered (`{}` when none did), `failed.owners` is true when any
 *     household's members read failed;
 *   - `peopleMeta` (the mockup's "in 5 systems") is not returned live either;
 *   - in fixture mode every `failed` flag is false and the fixtures come back
 *     exactly as before.
 *
 * `fetch` is stubbed globally and workspace.js is re-imported per test (it
 * caches the session response at module level), the same shape as
 * workspace-session-guard.test.js.
 */

/** Text that exists only in web/src/lib/data/fixtures/admin.js. */
const FIXTURE_TEXT = [
  "harlow-home",
  "polling every 30s",
  "ORBIT v1.3.0",
  "fd6a7e6",
  "orbit-app",
  "orbit-postgres",
  "orbit-clamav",
  "orbit-tika",
  "Ned Harlow",
  "Emma Harlow",
  "Sue Harlow",
  "Rob Harlow",
  "in 5 systems",
  "owns 2 systems",
];

const MAILBOX = {
  accountUser: "ops@mail.example.test",
  mailbox: "INBOX",
  pollSeconds: 60,
  enabled: true,
  configured: true,
  hasPassword: true,
  health: { status: "ok" },
};

const HEALTH = {
  build: { version: "0.3.0", channel: "stable", revision: "abcdef0123456" },
  services: [{ id: "database", state: "ok", checkedAt: "2026-10-15T11:59:00.000Z" }],
};

/** The household id is a fixture key on purpose: its owner must not be borrowed from the fixture. */
const HOUSEHOLD = { id: "hh-harlow-1", name: "Real Household", today: "2026-10-15" };

/** @typedef {"ok" | 403 | 500 | "network" | "absent"} Mode */

/**
 * @param {{ live: boolean, mailbox?: Mode, health?: Mode, members?: Mode }} opts
 */
function stubFetch({ live, mailbox = "ok", health = "ok", members = "ok" }) {
  /** @param {Mode} mode @param {unknown} body */
  const answer = (mode, body) => {
    if (mode === "network") throw new TypeError("Failed to fetch");
    if (mode === "absent") return new Response("{}", { status: 404 });
    if (mode === "ok") return new Response(JSON.stringify(body), { status: 200 });
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
    if (href.includes("/api/workspace")) return new Response(JSON.stringify({ workspace }), { status: 200 });
    if (href.includes("/api/admin/mailbox")) return answer(mailbox, { mailbox: MAILBOX });
    if (href.includes("/api/admin/health")) return answer(health, { health: HEALTH });
    if (href.includes("/members")) {
      return answer(members, { members: [{ role: "owner", displayName: "Pat Realowner" }] });
    }
    /* users, rotation, contact, upload limit, recovery bundle, operations: the
       additive reads, none of which this test is about. */
    return new Response("{}", { status: 404 });
  }));
}

/** @returns {Promise<any>} */
async function readAdmin() {
  const { readAdminScreen } = await import("../../web/src/lib/data/workspace.js");
  return readAdminScreen();
}

/** @param {unknown} view */
function expectNoFixtureText(view) {
  const text = JSON.stringify(view);
  for (const needle of FIXTURE_TEXT) expect(text, `found "${needle}"`).not.toContain(needle);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FAILURES = /** @type {const} */ ([
  ["refused (403)", 403],
  ["a server error (500)", 500],
  ["a network error", "network"],
]);

describe("readAdminScreen on a live instance", () => {
  it("with every read answering, shows the real values and marks nothing failed", async () => {
    stubFetch({ live: true });
    const view = await readAdmin();
    expect(view.failed).toEqual({ relay: false, services: false, instance: false, owners: false });
    expect(view.relay).toEqual(expect.arrayContaining([["collection domain", "mail.example.test", null]]));
    expect(view.instance).toContain("0.3.0");
    expect(view.owners).toEqual({ [HOUSEHOLD.id]: "Pat Realowner" });
    expectNoFixtureText(view);
  });

  describe.each(FAILURES)("when the read is %s", (_label, mode) => {
    it("relay (the mail panel): no mockup rows, marked failed", async () => {
      stubFetch({ live: true, mailbox: mode });
      const view = await readAdmin();
      expect(view.relay).toBeNull();
      expect(view.failed.relay).toBe(true);
      expect(view.failed.services).toBe(false);
      expectNoFixtureText(view);
    });

    it("services (the operations panel): no mockup rows, marked failed", async () => {
      stubFetch({ live: true, health: mode });
      const view = await readAdmin();
      expect(view.services).toBeNull();
      expect(view.failed.services).toBe(true);
      expect(view.failed.relay).toBe(false);
      expectNoFixtureText(view);
    });

    it("instance (the version strip): no mockup line, marked failed", async () => {
      stubFetch({ live: true, health: mode });
      const view = await readAdmin();
      expect(view.instance).toBeNull();
      expect(view.failed.instance).toBe(true);
      expectNoFixtureText(view);
    });

    it("owners: no borrowed owner names, marked failed", async () => {
      stubFetch({ live: true, members: mode });
      const view = await readAdmin();
      expect(view.owners).toEqual({});
      expect(view.failed.owners).toBe(true);
      expect(view.failed.relay).toBe(false);
      expectNoFixtureText(view);
    });
  });

  it("with every read failing, returns no fixture text anywhere and every panel failed", async () => {
    stubFetch({ live: true, mailbox: 403, health: 403, members: 403 });
    const view = await readAdmin();
    expect(view.failed).toEqual({ relay: true, services: true, instance: true, owners: true });
    expect(view.relay).toBeNull();
    expect(view.services).toBeNull();
    expect(view.instance).toBeNull();
    expect(view.owners).toEqual({});
    expect(view.peopleMeta ?? {}).toEqual({});
    expectNoFixtureText(view);
  });
});

describe("readAdminScreen in fixture mode", () => {
  it("returns the fixtures as today when the routes cannot answer, nothing marked failed", async () => {
    stubFetch({ live: false, mailbox: "absent", health: "absent", members: "absent" });
    const view = await readAdmin();
    expect(view.relay).toEqual(adminFixture.relay);
    expect(view.services).toEqual(adminFixture.services);
    expect(view.instance).toBe(adminFixture.instance);
    expect(view.owners).toEqual(adminFixture.owners);
    expect(view.peopleMeta).toEqual(adminFixture.peopleMeta);
    expect(view.failed).toEqual({ relay: false, services: false, instance: false, owners: false });
  });

  it("returns the fixtures even when a read is refused", async () => {
    stubFetch({ live: false, mailbox: 403, health: 500, members: "network" });
    const view = await readAdmin();
    expect(view.relay).toEqual(adminFixture.relay);
    expect(view.services).toEqual(adminFixture.services);
    expect(view.instance).toBe(adminFixture.instance);
    expect(view.owners).toEqual(adminFixture.owners);
    expect(view.failed).toEqual({ relay: false, services: false, instance: false, owners: false });
  });
});
