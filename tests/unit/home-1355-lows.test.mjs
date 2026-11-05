// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime, web } from "../support/svelte-page.mjs";

/*
 * #1355 (two of its five Lows, spec: the 2026-11-01 note), mounted on the desk
 * over the fixtures instance's home, as pocket-home-drawers does for the phone.
 *
 * 1. RANGE-F8/1: the "could not reach your home" banner follows the most recent
 *    read, whichever path made it. Only the mount read and the pocket's
 *    `onchanged` touched it, so a later read that succeeded (or failed) by any
 *    other path left it stale.
 * 5. b2 W-R1: the first tap of the two-tap approve arms it; a home refresh
 *    before the second tap puts the arm down, so the second tap arms again
 *    and approves nothing.
 */

vi.mock("$lib/tour/watch.js", () => ({ watchTour: () => () => {} }));
vi.mock("../../web/src/routes/home/home.behaviour.js", () => ({
  mountHome: () => () => {}, mountAccount: () => () => {}, mountEmptySky: () => () => {},
}));

const PAGE = "routes/home/+page.svelte";

/* The desk opens a row through history state (pushState/replaceState, read back as
   page.state.orbitItem). The loader's default stubs do nothing with it, so these
   keep it in a reactive map the page reads, which is all a row's opening needs. */
const REACTIVITY = pathToFileURL(join(web, "node_modules/svelte/src/reactivity/index-client.js")).href;
const APP_STATE = `import { SvelteMap } from ${JSON.stringify(REACTIVITY)};
const held = (globalThis.__orbitHeld ??= new SvelteMap());
export const page = {
  get url() { return new URL(globalThis.__svelteTestUrl ?? "http://localhost/home"); },
  params: {}, data: {}, status: 200, error: null, route: { id: null },
  get state() { return { orbitItem: held.get("orbitItem") }; },
};
`;
const APP_NAVIGATION = `const put = (url, state) => { globalThis.__orbitHeld.set("orbitItem", state?.orbitItem); globalThis.__svelteTestUrl = new URL(url, "http://localhost").href; };
export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};
export const goto = (...args) => globalThis.__svelteTestNavigation.goto(...args);
export const pushState = put; export const replaceState = put;
export const invalidate = async () => {}; export const invalidateAll = async () => {};
`;

describe("home's banner and arm, mounted on the desk (#1355)", () => {
  const loader = createPageLoader("home-1355-lows", {
    stubs: { "$app/state": APP_STATE, "$app/navigation": APP_NAVIGATION },
    stub: (file) => /\/lib\/(Chrome|pocket\/Sky|pocket\/NorthStar|flight\/Leave|flight\/Dawn|sun\/Sun|NorthStarMark)\.svelte$/.test(file),
  });
  beforeAll(() => loader.setup(PAGE));
  afterAll(() => loader.teardown());
  afterEach(() => {
    loader.unmount();
    vi.unstubAllGlobals();
    /** @type {any} */ (globalThis).__orbitHeld?.clear();
    /** @type {any} */ (globalThis).__svelteTestUrl = undefined;
  });

  /** @param {Parameters<typeof fixtureApi>[0]} [overrides] @param {any} [view] @param {string} [url] */
  async function mountHome(overrides = {}, view = null, url = "http://localhost/home") {
    const seen = { approvals: /** @type {any[]} */ ([]) };
    const api = fixtureApi({
      "GET /api/imap-inbox/*": ({ path }) => ({
        receipt: { id: path.split("/").pop(), draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
      }),
      "GET /api/households/*/items/*/documents": () => ({ documents: [] }),
      "PUT /api/imap-inbox/*": () => ({ ok: true }),
      "POST /api/reviewed-intake/approve": ({ body }) => { seen.approvals.push(body); return { outcome: "approved", itemId: "i-new" }; },
      "POST /api/workspace/commands": () => ({ ok: true }),
      ...overrides,
    });
    vi.stubGlobal("fetch", api.fetch);
    /* the desk: only the width query for 901px and up matches */
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: query.includes("901"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await loader.mount(PAGE, { data: { view, fixtures: true } }, { url });
    const { flushSync } = await runtime();
    const settle = async () => { await new Promise((done) => setTimeout(done, 0)); flushSync(); };
    return { api, seen, settle };
  }
  const $$ = (/** @type {string} */ selector) => /** @type {HTMLElement[]} */ ([...document.querySelectorAll(selector)]);

  /** A button of the page by its accessible name. @param {string} name */
  const button = (name) => $$(".desk button").find((one) => (one.getAttribute("aria-label") ?? "").trim() === name || (one.textContent ?? "").replace(/\s+/gu, " ").trim() === name);
  /** Presses it, and lets the page settle. @param {string} name @param {() => Promise<void>} settle */
  async function press(name, settle) {
    const one = button(name);
    expect(one, `a button named "${name}" is on the page`).toBeDefined();
    one?.click();
    await settle();
  }
  const calls = (/** @type {{ calls: { method: string, path: string }[] }} */ api, /** @type {string} */ path) =>
    api.calls.filter((c) => c.method === "POST" && c.path === path).length;
  /** Opens a row with the page's own click, and waits for its drawer. @param {string} id @param {() => Promise<void>} settle */
  async function openRow(id, settle) {
    $$(`.desk a.item[id="${id}"]`)[0].click();
    await vi.waitFor(() => expect($$(`.desk [id="${id}-view"]`)).toHaveLength(1));
    await settle();
  }
  const banner = () => document.querySelector("p.p-error[role=alert]")?.textContent ?? null;
  const desk = async (/** @type {Parameters<typeof mountHome>} */ ...how) => {
    const mounted = await mountHome(...how);
    await vi.waitFor(() => expect($$(".desk a.item.suggest")).toHaveLength(1));
    await mounted.settle();
    return mounted;
  };

  it("#1355 (1): the offline banner follows the most recent read, not only the mount and onchanged reads", async () => {
    /* home arrives from the server, so its rows are drawn while the mount read fails once */
    vi.stubGlobal("fetch", fixtureApi().fetch);
    const { readHome } = await import("../../web/src/lib/data/workspace.js");
    const first = await readHome();
    let workspaceReads = 0;
    const { api, seen, settle } = await desk({
      "GET /api/workspace": () => {
        workspaceReads += 1;
        if (workspaceReads === 1) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
        return fixtureApi().fetch("/api/workspace").then((r) => r.json());
      },
    }, first);
    await vi.waitFor(() => expect(banner()).toContain("could not reach your home"));
    /* a later read, by a path that is neither the mount nor the pocket's onchanged: approving reads home again */
    await openRow("r-insurance", settle);
    await press("Add to orbit", settle);
    await press("tap again to approve", settle);
    await settle();
    await vi.waitFor(() => expect(seen.approvals).toHaveLength(1));
    await vi.waitFor(() => expect(workspaceReads).toBeGreaterThan(1));
    for (let turn = 0; turn < 5; turn += 1) await settle();
    expect(calls(api, "/api/reviewed-intake/approve")).toBe(1);
    expect(banner(), "the banner still claims home cannot be reached after a read that worked").toBeNull();
  });

  it("#1355 (5): an armed approve is put down when home refreshes before the second tap", async () => {
    const { api, seen, settle } = await desk();
    await openRow("r-insurance", settle);
    await press("Add to orbit", settle);
    expect(button("tap again to approve"), "the first tap armed it").toBeDefined();
    /* home refreshes: another item is retired, and the page reads home again */
    const reads = () => api.calls.filter((c) => c.method === "GET" && c.path === "/api/workspace").length;
    const readsBefore = reads();
    await openRow("i-gutter", settle);
    await press("Retire Gutter clearing", settle);
    await press("Retire Gutter clearing: press again to confirm", settle);
    await vi.waitFor(() => expect(calls(api, "/api/workspace/commands")).toBe(1));
    for (let turn = 0; turn < 5; turn += 1) await settle();
    expect(reads(), "home was read again").toBeGreaterThan(readsBefore);
    await openRow("r-insurance", settle);
    expect(button("tap again to approve"), "the arm survived the refresh").toBeUndefined();
    await press("Add to orbit", settle);
    expect(seen.approvals, "the second tap approved on an arm from before the refresh").toHaveLength(0);
  });
});
