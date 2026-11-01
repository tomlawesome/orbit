// @vitest-environment happy-dom
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createPageLoader } from "../support/svelte-page.mjs";

/*
 * #1440: the desk account menu offered "Administration" to every reader. It
 * is the instance administrator's screen, so the menu offers it only when the
 * root layout says the reader is one (the same fact the phone hatch already
 * uses): ordinary entries for everyone, Administration for an administrator.
 *
 * Moved from web/tests/fidelity/desk-menu-administration.spec.js (ADR-0039,
 * #1613). Which entries the menu lists is markup and one fact from the root
 * layout's data, so Chrome.svelte (the menu /settings and /inbox draw, with
 * `current` naming the page) is mounted in happy-dom with the layout's
 * `isAdmin` set the way SvelteKit hands it, and the root layout's own load is
 * called for the fact itself. /home draws its own copy of the menu inside a
 * 2,000-line page that cannot be mounted here (see v19-home-shared-acts), so
 * its two runs stay on the rig.
 */

vi.mock("$lib/data/workspace.js", () => ({
  signOut: () => new Promise(() => {}),
  wordsOf: (/** @type {unknown} */ _e, /** @type {string} */ fallback) => fallback,
}));
vi.mock("$lib/tour/watch.js", () => ({ watchTour: () => () => {} }));
vi.mock("orbit/server/documents/tika", () => ({ documentReadingEnabled: () => false }));

/** @type {any} */ (globalThis).__orbitPage = { url: new URL("http://localhost/settings"), params: {}, data: {}, state: {} };
const page = createPageLoader("desk-menu", {
  stubs: {
    "$app/state": "export const page = globalThis.__orbitPage;\n",
    "lib/flight/Leave.svelte": "export default function Leave() {}\n",
    /* The phone's hatch sits inside its bottom sheet, which listens for navigation; the desk menu has no part in it. */
    "lib/pocket/Sheet.svelte": "export default function Sheet() {}\n",
  },
});
afterEach(() => page.unmount());
afterAll(() => { page.teardown(); delete (/** @type {any} */ (globalThis)).__orbitPage; });

/**
 * The desk menu of Chrome.svelte on the page named by `current`, the layout's `isAdmin` as given.
 * @param {string} current @param {boolean} isAdmin
 */
async function deskMenu(current, isAdmin) {
  /** @type {any} */ (globalThis).__orbitPage.data = { isAdmin };
  const { target } = await page.mount("lib/Chrome.svelte", {
    user: { displayName: "Ned Harlow" },
    household: { name: "Harlow home", canManage: true },
    current,
  });
  const nav = target.querySelector("#account nav");
  expect(nav, "the desk menu is drawn").not.toBeNull();
  return [.../** @type {Element} */ (nav).querySelectorAll("a")].map((a) => a.textContent?.trim());
}

describe.each(["settings", "inbox"])("the desk account menu on /%s", (route) => {
  it("offers no Administration to a non-administrator", async () => {
    const entries = await deskMenu(route, false);
    expect(entries).toEqual(["Inbox", "Settings", "About"]);
  });

  it("offers Administration to an instance administrator, between Settings and About", async () => {
    const entries = await deskMenu(route, true);
    expect(entries).toEqual(["Inbox", "Settings", "Administration", "About"]);
  });
});

describe("the root layout says who an administrator is", () => {
  /** @param {unknown} session */
  async function layoutSays(session) {
    const { load } = await import("../../web/src/routes/+layout.server.js");
    return /** @type {any} */ (load)({ locals: { session } }).isAdmin;
  }

  it("is true for an instance administrator's session", async () => {
    expect(await layoutSays({ user: { id: "u1", isInstanceAdmin: true } })).toBe(true);
  });

  it("is false for a member, and for no session at all (the fixture harness's reader)", async () => {
    expect(await layoutSays({ user: { id: "u2", isInstanceAdmin: false } })).toBe(false);
    expect(await layoutSays(undefined)).toBe(false);
  });
});
