// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPageLoader, web } from "../support/svelte-page.mjs";

/*
 * #1701: if the sheet's history entry never clears (the back never lands), the
 * sign-out must not hang for good: after a bounded wait the goodbye starts
 * anyway. Same stand-in router as pocket-sign-out-waits-for-history.test.mjs,
 * but `history.back()` does nothing at all.
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
  for (const [k, v] of Object.entries(state ?? {})) globalThis.__router.entries.set(k, v);
};
`;
const WORKSPACE = `export const signOut = async () => "https://idp.invalid/end";
export const wordsOf = (_error, fallback) => fallback;
`;

describe("pocket sign-out: the goodbye does not hang when the history entry never clears (#1701)", () => {
  const loader = createPageLoader("pocket-sign-out-fallback", {
    stubs: {
      "$app/state": ROUTER_STATE,
      "$app/navigation": ROUTER_NAV,
      "$lib/data/workspace.js": WORKSPACE,
      "$lib/tour/watch.js": "export const watchTour = async () => {};\n",
    },
  });
  beforeAll(() => loader.setup("lib/pocket/Hatch.svelte"));
  afterAll(() => loader.teardown());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    loader.unmount();
    /** @type {any} */ (globalThis).__router?.entries.clear();
  });

  const press = () => /** @type {HTMLButtonElement} */ (
    [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "sign out →")
  ).click();

  it("starts the goodbye after the bounded wait, and only then", async () => {
    const goodbye = vi.fn();
    await loader.mount("lib/pocket/Hatch.svelte", { open: true, name: "Emma Harlow", onsignedout: goodbye });
    expect(/** @type {any} */ (globalThis).__router.entries.has("pocketSheet")).toBe(true);
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    press();
    await vi.advanceTimersByTimeAsync(1000);
    expect(goodbye, "the goodbye started before the wait ran out").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(goodbye, "the entry never cleared and the sign-out hung").toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount(), "the fallback timer is cleared once it has fired").toBe(0);
  });

  it("leaves no timer behind when the sheet goes away while waiting", async () => {
    const goodbye = vi.fn();
    await loader.mount("lib/pocket/Hatch.svelte", { open: true, name: "Emma Harlow", onsignedout: goodbye });
    vi.spyOn(window.history, "back").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    press();
    await vi.advanceTimersByTimeAsync(100);
    loader.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount(), "a fallback timer outlived the sheet").toBe(0);
  });
});
