// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPageLoader, web } from "../support/svelte-page.mjs";

/*
 * #1701: the pocket sign-out's goodbye waits for the sheet's history entry to
 * be gone (the `pocketSheet` page state is clear), not for a 400 ms timer. If
 * the sheet pushed no entry, the goodbye starts at once. The popstate listener
 * is removed on every path.
 *
 * The real Hatch and Sheet are mounted in happy-dom. Only the router is
 * stood in for: `page.state` is a live map, `pushState` sets `pocketSheet` in
 * it, and `history.back()` (a spy) lets its popstate arrive after `backAfter`
 * ms and the page state clear `clearAfter` ms after that, the order SvelteKit
 * does it in (the event first, the state once the navigation has run).
 */

const reactivity = `${web}/node_modules/svelte/src/reactivity/index-client.js`;
const ROUTER_STATE = `import { SvelteMap } from ${JSON.stringify(reactivity)};
const entries = new SvelteMap();
globalThis.__router = { entries };
export const page = {
  get state() {
    return new Proxy({}, {
      get: (_, key) => entries.get(key),
      ownKeys: () => [...entries.keys()],
      getOwnPropertyDescriptor: (_, key) => (entries.has(key) ? { enumerable: true, configurable: true, value: entries.get(key) } : undefined),
    });
  },
  url: new URL("http://localhost/home"), params: {}, data: {}, status: 200, error: null, route: { id: null },
};
`;
const ROUTER_NAV = `export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};
export const goto = async () => {}; export const replaceState = () => {};
export const invalidate = async () => {}; export const invalidateAll = async () => {};
export const pushState = (_url, state) => {
  if (globalThis.__pushes) for (const [k, v] of Object.entries(state ?? {})) globalThis.__router.entries.set(k, v);
};
`;
const WORKSPACE = `export const signOut = async () => "https://idp.invalid/end";
export const wordsOf = (_error, fallback) => fallback;
`;

describe("pocket sign-out: the goodbye waits for the sheet's history entry (#1701)", () => {
  const loader = createPageLoader("pocket-sign-out", {
    stubs: {
      "$app/state": ROUTER_STATE,
      "$app/navigation": ROUTER_NAV,
      "$lib/data/workspace.js": WORKSPACE,
      "$lib/tour/watch.js": "export const watchTour = async () => {};\n",
    },
  });
  beforeAll(() => loader.setup("lib/pocket/Hatch.svelte"));
  afterAll(() => loader.teardown());

  /** @type {Array<() => void>} */
  const undo = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const fn of undo.splice(0)) fn();
    loader.unmount();
    router()?.entries.clear();
  });

  const router = () => /** @type {any} */ (globalThis).__router;

  /**
   * Opens the hatch, then presses sign out.
   * @param {{ pushes: boolean, backAfter?: number, clearAfter?: number }} how
   */
  async function pressSignOut({ pushes, backAfter = 600, clearAfter = 100 }) {
    const goodbye = vi.fn();
    /** @type {any} */ (globalThis).__pushes = pushes;
    router()?.entries.clear();
    await loader.mount("lib/pocket/Hatch.svelte", { open: true, name: "Emma Harlow", onsignedout: goodbye });
    expect(router().entries.has("pocketSheet"), "the stub router and the sheet agree on the pushed entry").toBe(pushes);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {
      setTimeout(() => {
        window.dispatchEvent(new Event("popstate"));
        setTimeout(() => router().entries.clear(), clearAfter);
      }, backAfter);
    });
    undo.push(() => back.mockRestore());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    return { goodbye, back };
  }


  /**
   * Watches the popstate listeners added from now on. `leaked()` dispatches a
   * popstate and returns how many of them are still registered (a `once`
   * listener that has fired is gone, one that was removed is gone).
   */
  function watchPopstate() {
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    /** @type {Map<unknown, EventListener>} */
    const wrappers = new Map();
    let seen = 0;
    const add = vi.spyOn(window, "addEventListener").mockImplementation((type, fn, options) => {
      if (type !== "popstate" || typeof fn !== "function") return realAdd(type, fn, options);
      const wrapper = (/** @type {Event} */ event) => { seen += 1; return fn(event); };
      wrappers.set(fn, wrapper);
      return realAdd(type, wrapper, options);
    });
    const remove = vi.spyOn(window, "removeEventListener").mockImplementation((type, fn, options) =>
      realRemove(type, wrappers.get(fn) ?? fn, options));
    undo.push(() => { add.mockRestore(); remove.mockRestore(); });
    return () => {
      const before = seen;
      window.dispatchEvent(new Event("popstate"));
      return seen - before;
    };
  }

  const press = () => /** @type {HTMLButtonElement} */ (
    [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "sign out →")
  ).click();

  it("does not start the goodbye at 400 ms while the sheet's history entry is still there", async () => {
    const { goodbye } = await pressSignOut({ pushes: true });
    press();
    await vi.advanceTimersByTimeAsync(450);
    expect(goodbye, "the goodbye started on the 400 ms timer, with the sheet's entry still in the page state").not.toHaveBeenCalled();
  });

  it("starts the goodbye once the page state is clear, not on the popstate before it", async () => {
    const { goodbye } = await pressSignOut({ pushes: true, backAfter: 600, clearAfter: 100 });
    press();
    await vi.advanceTimersByTimeAsync(650);
    expect(goodbye, "the goodbye started before the page state was clear").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(goodbye, "the goodbye never started once the entry was gone").toHaveBeenCalledTimes(1);
  });

  it("starts the goodbye at once when the sheet pushed no entry", async () => {
    const { goodbye, back } = await pressSignOut({ pushes: false });
    press();
    await vi.advanceTimersByTimeAsync(50);
    expect(back, "no entry was pushed, so nothing is popped").not.toHaveBeenCalled();
    expect(goodbye, "the goodbye waited when there was no entry to wait for").toHaveBeenCalledTimes(1);
  });

  it("leaves no popstate listener behind when there was no entry", async () => {
    const { goodbye } = await pressSignOut({ pushes: false });
    const leaked = watchPopstate();
    press();
    await vi.advanceTimersByTimeAsync(1000);
    expect(goodbye).toHaveBeenCalled();
    expect(leaked(), "popstate listeners added by the sign-out and still registered after it").toBe(0);
  });
});
