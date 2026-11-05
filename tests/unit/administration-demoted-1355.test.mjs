// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
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

  async function mountDemoted() {
    const api = fixtureApi({
      "GET /api/workspace": refused,
      "GET /api/auth/session": refused,
      "GET /api/admin/users": refused,
      "GET /api/admin/mailbox": refused,
      "GET /api/admin/contact": refused,
      "GET /api/admin/upload-limit": refused,
    });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await loader.mount(PAGE, { data: { fixtures: false } }, { url: "http://localhost/administration" });
    const { flushSync } = await runtime();
    for (let turn = 0; turn < 10; turn += 1) { await new Promise((done) => setTimeout(done, 0)); flushSync(); }
    return { api };
  }

  it("is not offered a 'try again' on a screen whose every read answers 403", async () => {
    await mountDemoted();
    const retries = [...document.querySelectorAll("button")].filter((one) => /try again/iu.test(one.textContent ?? ""));
    expect(retries.map((one) => one.closest("[role=alert]")?.textContent), "a retry that can never succeed").toEqual([]);
    expect(document.body.textContent).not.toMatch(/could not (reach|load)/iu);
  });

  it("asks the shell to read the layout again, so the Administration link goes", async () => {
    await mountDemoted();
    expect(/** @type {any} */ (globalThis).__layoutRefreshed ?? [], "neither invalidate nor invalidateAll was called").not.toEqual([]);
  });
});
