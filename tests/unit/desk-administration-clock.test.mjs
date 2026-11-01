// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageBuilder, settle } from "./happy-page-mount-lib.mjs";

/*
 * #1584 web-admin-1: the desk's "delete now" on a system on the clock. The
 * command lands and only the re-read after it fails. The row is gone whatever
 * the read did, so its replacement line says so and tells the reader the
 * screen was not refreshed; the confirm is closed and nothing says "not
 * deleted".
 *
 * Moved from web/tests/fidelity/desk-administration-clock.spec.js (ADR-0039,
 * #1613). The act itself (deleteSystemNow: landed once, "gone for good",
 * "reload", never "not deleted") is proven for the desk and the phone in
 * administration-landed-then-reread.test.mjs; what this adds is the screen
 * around it, mounted in happy-dom: the row on the clock goes, the line it
 * leaves is drawn, and the confirm that opened it is shut. The data layer is
 * stood in for (the screen read and the one command), as in
 * administration-failed-card-screens.test.mjs.
 */

const server = vi.hoisted(() => ({
  /** @type {(() => Promise<unknown>) | null} */ read: null,
  hardDeleted: /** @type {unknown[][]} */ ([]),
}));
vi.mock("$lib/data/workspace.js", () => {
  const never = () => { throw new Error("not under test"); };
  return {
    readAdminScreen: () => (/** @type {() => Promise<unknown>} */ (server.read))(),
    hardDeleteHousehold: async (/** @type {unknown[]} */ ...args) => { server.hardDeleted.push(args); return {}; },
    wordsOf: (/** @type {unknown} */ error, /** @type {string} */ fallback) => (error instanceof Error ? error.message : fallback),
    addMember: never, commandContact: never, commandMailbox: never, commandUploadLimit: never,
    createLocalUser: never, createSystem: never, readSignInMethods: async () => [], restoreHousehold: never,
    retryDocumentJob: never, sendSetupLink: never, setUserDisabled: never, startStepUp: never, testMail: never,
  };
});

/** @type {any} */ (globalThis).__orbitPage = { url: new URL("http://localhost/administration"), params: {}, data: {}, state: {} };
const page = createPageBuilder("desk-admin-clock", {
  stubs: {
    "$app/state": "export const page = globalThis.__orbitPage;\n",
    "lib/Chrome.svelte": "export default function Chrome() {}\n",
    "lib/backdrops/station.js": "export const mountStation = () => () => {};\n",
    "lib/pocket/media.js": 'export const isPocket = () => false; export const pocketQuery = "(max-width: 0px)";\n',
    "lib/pocket/wake.js": "export const wake = () => {}; export const WAKE_HOLD_MS = 0;\n",
  },
});
beforeEach(() => { server.hardDeleted = []; });
afterEach(() => page.unmountAll());
afterAll(() => { page.dispose(); delete (/** @type {any} */ (globalThis)).__orbitPage; });

const NOW = "2026-08-13T12:00:00.000Z";
const AHEAD = new Date(Date.parse(NOW) + 13 * 86400000).toISOString();
const FAILED_KEYS = ["relay", "services", "instance", "owners", "users", "contact", "uploadLimit", "operations", "rotation", "metadata", "recoveryBundle"];

/** The screen readAdminScreen() answers: an administrator, one system on the clock, every read answered. */
function screen() {
  return {
    user: { id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true },
    household: null,
    primary: null,
    today: "2026-08-13",
    users: [{ id: "u1", displayName: "Ada Admin", email: "ada@example.invalid", isInstanceAdmin: true, disabledAt: null }],
    households: [],
    peopleMeta: {},
    relay: [],
    services: [],
    instance: "orbit",
    failed: Object.fromEntries(FAILED_KEYS.map((key) => [key, false])),
    health: null,
    now: NOW,
    operations: { jobs: [], counts: {} },
    recoverable: [{ id: "hh-gone-1", name: "Aunt May’s Cottage", deleteAfter: AHEAD }],
    mailbox: null,
    contact: { name: null, email: null },
    uploadLimit: { maxBytes: 26214400, defaultBytes: 26214400, overrideBytes: null, minBytes: 1048576, ceilingBytes: 104857600, version: 1, updatedAt: null },
    rotation: null,
    metadata: null,
    recoveryBundle: null,
    owners: {},
  };
}

/** @param {Element | null} el */
const button = (el, text) => /** @type {HTMLButtonElement | undefined} */ (
  [...(el?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === text));

describe("a delete-now whose re-read fails (#1584 web-admin-1)", () => {
  it("replaces the row with a line that says done, and nothing says not deleted", async () => {
    /* The first read is the screen's own load; every read after it fails. */
    let reads = 0;
    server.read = async () => {
      reads += 1;
      if (reads === 1) return screen();
      throw new Error("the screen would not load");
    };
    const { target, flushSync } = await page.mount("routes/administration/+page.svelte", { data: { fixtures: false } });
    await settle();
    const doomed = () => [...target.querySelectorAll(".system.doomed")].find((row) => row.textContent?.includes("Aunt May"));
    expect(doomed(), "the system on the clock is drawn").toBeDefined();

    button(doomed() ?? null, "delete now →")?.click();
    flushSync();
    const field = /** @type {HTMLInputElement} */ (target.querySelector("#doomname-hh-gone-1"));
    expect(field, "the confirm asks for the name").not.toBeNull();
    field.value = "Aunt May’s Cottage";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    button(doomed() ?? null, "delete now")?.click();
    flushSync();
    button(doomed() ?? null, "tap again to delete for good")?.click();
    flushSync();
    await settle();

    expect(server.hardDeleted, "the command went once").toEqual([["hh-gone-1", "Aunt May’s Cottage"]]);
    expect(reads, "the screen was read again, and that read failed").toBeGreaterThan(1);
    const gone = target.querySelector(".adminproblem.gone");
    expect(gone?.textContent).toContain("Aunt May’s Cottage is gone for good");
    expect(gone?.textContent).toContain("reload");
    expect(doomed(), "the row on the clock has left").toBeUndefined();
    expect(target.querySelectorAll(".confirm"), "the confirm is closed").toHaveLength(0);
    expect(target.textContent).not.toContain("not deleted");
  });
});
