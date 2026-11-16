// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";

/*
 * #1355 (2 of the five Lows, spec: the 2026-11-01 note; origin #1426 follow-up,
 * the 2026-10-15 review note on #1439 #1440 #1442): an administrator demoted
 * while /administration is open has every read answered 403. The server gate
 * holds, but the page called it "Orbit could not reach ..." and offered a
 * "try again" that can never succeed, and the Administration link stayed in
 * the shell because the root layout load (`isAdmin`, from `locals` alone) is
 * not re-run by client navigation.
 *
 * Required: a 403 on the screen's reads is shown as a refusal -- no retry
 * offered -- and the layout's data is invalidated (invalidate or invalidateAll)
 * so the next load of +layout.server.js drops `isAdmin` and with it the link.
 * (+layout.server.js itself already answers isAdmin false for a demoted
 * session; what is missing is anything that makes the shell ask again.)
 */

vi.mock("$lib/backdrops/station.js", () => ({ mountStation: () => () => {} }));

const PAGE = "routes/administration/+page.svelte";
const NAVIGATION = `export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};
export const goto = (...args) => globalThis.__svelteTestNavigation.goto(...args); export const pushState = () => {}; export const replaceState = () => {};
export const invalidate = async (...a) => { (globalThis.__layoutRefreshed ??= []).push(["invalidate", ...a]); };
export const invalidateAll = async (...a) => { (globalThis.__layoutRefreshed ??= []).push(["invalidateAll", ...a]); };
`;

const refused = () => new Response(JSON.stringify({ error: { code: "forbidden", message: "Administrator only" } }), {
  status: 403, headers: { "content-type": "application/json" },
});

describe("a demoted administrator on /administration (#1355)", () => {
  const loader = createPageLoader("administration-demoted-1355", {
    stub: (file) => /\/lib\/Chrome\.svelte$/.test(file),
    stubs: { "$app/navigation": NAVIGATION },
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  afterEach(() => {
    loader.unmount();
    vi.unstubAllGlobals();
    /** @type {any} */ (globalThis).__layoutRefreshed = [];
  });

  const ADMIN_READS = [
    "users", "mailbox", "contact", "upload-limit", "mail-limit", "documents/rotation", "documents/health",
    "recovery-bundle", "health", "operations",
  ];

  /**
   * The server as it really answers a demoted administrator who is still a
   * household member: /api/workspace and the session read by user and session,
   * so they answer 200; every /api/admin read answers 403 (or `admin` says
   * otherwise for the case under test).
   * @param {Record<string, () => unknown>} [admin]
   */
  async function mount(admin = {}) {
    /* a live instance: its workspace answer carries no `fixtureToday`, which would put the screen on mock-up values */
    /** @type {Record<string, () => unknown>} */
    const routes = { "GET /api/workspace": () => {
      const workspace = structuredClone(WORKSPACE_FIXTURE);
      for (const household of workspace.households) /** @type {any} */ (household).today = "2026-10-03";
      return { workspace };
    } };
    for (const read of ADMIN_READS) routes[`GET /api/admin/${read}`] = refused;
    const api = fixtureApi({ ...routes, ...admin });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await loader.mount(PAGE, { data: { fixtures: false } }, { url: "http://localhost/administration" });
    const { flushSync } = await runtime();
    for (let turn = 0; turn < 10; turn += 1) { await new Promise((done) => setTimeout(done, 0)); flushSync(); }
    return { api };
  }
  const retries = () => [...document.querySelectorAll("button")]
    .filter((one) => /try again/iu.test(one.textContent ?? ""))
    .map((one) => (one.closest("[role=alert]")?.textContent ?? "").replace(/\s+/gu, " "));
  const refreshed = () => /** @type {any} */ (globalThis).__layoutRefreshed ?? [];

  it("every admin read answering 403 (workspace still 200) offers no 'try again' on any panel", async () => {
    await mount();
    expect(retries(), "retries that can never succeed").toEqual([]);
  });

  it("every admin read answering 403 asks the shell to read the layout again, so the Administration link goes", async () => {
    await mount();
    expect(refreshed(), "neither invalidate nor invalidateAll was called").not.toEqual([]);
  });

  it("one admin read failing with a 500 keeps that panel's own retry and does not re-read the layout", async () => {
    await mount({
      "GET /api/admin/documents/rotation": () => ({ rotation: null }),
      "GET /api/admin/upload-limit": () => new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500, headers: { "content-type": "application/json" },
      }),
    });
    expect(retries().some((words) => /upload limit/iu.test(words)), `no upload-limit retry among ${JSON.stringify(retries())}`).toBe(true);
    expect(refreshed()).toEqual([]);
  });
});
