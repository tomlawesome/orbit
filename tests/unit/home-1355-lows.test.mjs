// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fixtureApi } from "../support/fixture-api.mjs";
import { createPageLoader, runtime, web } from "../support/svelte-page.mjs";
import { subscribeWake } from "$lib/pocket/wake.js";
import { HELD_COMPLETION_KEY } from "$lib/data/held-completion.js";

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
 *
 * #1355, #1671 (design call, 2026-11-05): the banner is the MOUNT read's voice
 * only. A later re-read may take it down on success, but a failed one never
 * raises it; after an act that landed, a failed re-read says the ratified
 * done-but-unread line (landed.js DONE_UNREAD) and nothing else.
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
  /* the offline banner by its own words: a row's done-but-unread line is also a p-error alert */
  const banner = () => [...document.querySelectorAll("p.p-error[role=alert]")]
    .map((el) => el.textContent ?? "").find((text) => text.startsWith("Orbit could not reach your home")) ?? null;
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

  /* ---- #1355, #1671: the banner is the mount read's voice only ---------- */

  /** Words the wake said, from now on (the wake standing now is a previous test's). */
  function watchWakes() {
    /** @type {string[]} */
    const said = [];
    let replay = true;
    const stop = subscribeWake((entry) => { if (replay) { replay = false; return; } if (entry) said.push(entry.message); });
    stops.push(stop);
    return said;
  }
  /** @type {(() => void)[]} */
  const stops = [];
  afterEach(() => { down.on = false; for (const stop of stops.splice(0)) stop(); try { localStorage.removeItem(HELD_COMPLETION_KEY); } catch { /* none */ } });

  /** home reads fail from the moment `down.on` is set (the act under test sets it as it lands) */
  const down = { on: false };
  const homeRead = () => down.on
    ? new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 })
    : fixtureApi().fetch("/api/workspace").then((r) => r.json());
  const settleMany = async (/** @type {() => Promise<void>} */ settle) => { for (let turn = 0; turn < 6; turn += 1) await settle(); };

  /** The phone, mounted over the same fixtures. @param {Parameters<typeof fixtureApi>[0]} overrides */
  async function mountPocket(overrides) {
    const seen = { approvals: /** @type {any[]} */ ([]), joins: 0 };
    const api = fixtureApi({
      "GET /api/imap-inbox/*": ({ path }) => ({
        receipt: { id: path.split("/").pop(), draftVersion: 3, proposal: { title: "Home insurance renewal" } },
        sections: [{ id: "s-home" }, { id: "s-dates" }],
        attachments: [{ id: "a-1" }],
      }),
      "PUT /api/imap-inbox/*": () => ({ ok: true }),
      ...overrides,
    });
    vi.stubGlobal("fetch", api.fetch);
    vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
      matches: !query.includes("901"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await loader.mount(PAGE, { data: { view: null, fixtures: true } }, { url: "http://localhost/home" });
    const { flushSync } = await runtime();
    const settle = async () => { await new Promise((done) => setTimeout(done, 0)); flushSync(); };
    return { api, seen, settle };
  }
  const doneUnread = /^done —/u;

  it("#1671 (1): a failed re-read after a landed approve, on the desk, raises no banner and the wake says done-but-unread", async () => {
    const wakes = watchWakes();
    const { settle } = await desk({
      "GET /api/workspace": homeRead,
      "POST /api/reviewed-intake/approve": () => { down.on = true; return { outcome: "approved", itemId: "i-new" }; },
    });
    expect(banner(), "no banner stands before the act").toBeNull();
    /* the amend path's add is the one that wakes (the plain two-tap says its line under the row) */
    await openRow("r-insurance", settle);
    await press("review & amend →", settle);
    await press("add to orbit", settle);
    await vi.waitFor(() => expect(down.on).toBe(true));
    await settleMany(settle);
    expect(wakes.some((words) => doneUnread.test(words)), `the wake said ${JSON.stringify(wakes)}`).toBe(true);
    expect(banner(), "a failed re-read after the act raised the offline banner").toBeNull();
  });

  it("#1671 (2): the pocket's onchanged raises no banner after a landed act, and still throws so the act says done-but-unread", async () => {
    const wakes = watchWakes();
    const { settle } = await mountPocket({
      "GET /api/workspace": homeRead,
      "POST /api/reviewed-intake/approve": () => { down.on = true; return { outcome: "approved", itemId: "i-new" }; },
    });
    await vi.waitFor(() => expect(document.querySelector(".pocket .pk-below [data-row]")).not.toBeNull());
    await settle();
    const catch_ = /** @type {HTMLElement} */ ($$(".pocket .pk-signals [data-row]").find((el) => el.textContent?.includes("Home insurance")));
    /** @param {string} name */
    const tap = async (name) => {
      const one = [...catch_.querySelectorAll("button, a")].find((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === name);
      expect(one, `a control named "${name}"`).toBeDefined();
      /** @type {HTMLElement} */ (one).click();
      await settle();
    };
    /** @type {HTMLElement} */ (catch_.querySelector("[data-row-face]")).click();
    await settle();
    await tap("review & amend →");
    await tap("add to orbit");
    await vi.waitFor(() => expect(down.on).toBe(true));
    await settleMany(settle);
    expect(banner(), "the pocket's failed re-read raised the offline banner").toBeNull();
    expect(wakes.some((words) => doneUnread.test(words)), `the failure did not reach the act: the wake said ${JSON.stringify(wakes)}`).toBe(true);
  });

  it("#1671 (3): a held completion that lands and whose re-read fails says done-but-unread, not nothing", async () => {
    const wakes = watchWakes();
    /* a completion an earlier visit held: the desk sends it on arriving */
    localStorage.setItem(HELD_COMPLETION_KEY, JSON.stringify([{
      type: "item.complete", householdId: "hh-harlow-1", itemId: "i-gutter", expectedVersion: 1, completedDate: "2026-08-13",
      activity: { id: "a-held", itemId: "i-gutter", occurredAt: "2026-08-13T09:00:00.000Z" },
    }]));
    const { api, settle } = await desk({
      "GET /api/workspace": homeRead,
      "POST /api/workspace/commands": () => { down.on = true; return { ok: true }; },
    });
    await vi.waitFor(() => expect(calls(api, "/api/workspace/commands")).toBe(1));
    await settleMany(settle);
    expect(wakes.some((words) => doneUnread.test(words)), `the wake said ${JSON.stringify(wakes)}`).toBe(true);
    expect(banner(), "a failed re-read after the held completion raised the banner").toBeNull();
  });

  it("#1671 (4): a join request that landed whose re-read fails is not kept as the ask's failure; done-but-unread is said", async () => {
    const wakes = watchWakes();
    const sky = () => ({ workspace: {
      version: 1, activeHouseholdId: null, householdLanding: "choose", households: [],
      visibleHouseholds: [{ id: "hh-seaside-4551", name: "Seaside Cottage" }],
    } });
    const { api, settle } = await mountPocket({
      "GET /api/workspace": () => (down.on ? new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 }) : sky()),
      "POST /api/households/*/join-requests": () => { down.on = true; return {}; },
    });
    await vi.waitFor(() => expect($$("[data-ask]")).toHaveLength(1));
    await settle();
    const askRow = () => $$("[data-ask]")[0];
    askRow().click();
    await settle();
    $$(".askcard button.yes")[0].click();
    await vi.waitFor(() => expect(calls(api, "/api/households/hh-seaside-4551/join-requests")).toBe(1));
    await settleMany(settle);
    expect(wakes.some((words) => doneUnread.test(words)), `the wake said ${JSON.stringify(wakes)}`).toBe(true);
    expect(banner(), "a failed re-read after the request raised the offline banner").toBeNull();
    /* the card closed on the landed request; opening it again must not show the read's failure as the ask's */
    askRow().click();
    await settle();
    expect($$(".askcard")).toHaveLength(1);
    expect($$(".askcard .askproblem").map((el) => el.textContent), "the failed read is shown as the ask's problem").toEqual([]);
  });

  it("#1671 (5): a good later read still takes a stale banner down", async () => {
    vi.stubGlobal("fetch", fixtureApi().fetch);
    const { readHome } = await import("../../web/src/lib/data/workspace.js");
    const first = await readHome();
    let reads = 0;
    const { api, settle } = await desk({
      "GET /api/workspace": () => {
        reads += 1;
        return reads === 1 ? new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 }) : fixtureApi().fetch("/api/workspace").then((r) => r.json());
      },
    }, first);
    await vi.waitFor(() => expect(banner()).toContain("could not reach your home"));
    /* a later read by another path: retiring an item reads home again */
    await openRow("i-gutter", settle);
    await press("Retire Gutter clearing", settle);
    await press("Retire Gutter clearing: press again to confirm", settle);
    await vi.waitFor(() => expect(calls(api, "/api/workspace/commands")).toBe(1));
    await settleMany(settle);
    expect(reads).toBeGreaterThan(1);
    expect(banner(), "the banner outlived a read that worked").toBeNull();
  });
});
