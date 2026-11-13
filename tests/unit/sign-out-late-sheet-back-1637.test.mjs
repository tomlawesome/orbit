// @vitest-environment happy-dom
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPageLoader, web } from "../support/svelte-page.mjs";

/*
 * #1637: the pocket sheet's history.back() can land after the sheet's 1.5 s
 * SETTLE_FALLBACK_MS has run out. The goodbye has then started, the farewell
 * (Leave.svelte onFarewell) has replaced the sheet's entry with /logout, and the
 * late back steps to the entry under it (/settings): the address ends there.
 * Required: when the farewell finds the router's page state still carrying a
 * `pocketSheet` entry, the next popstate (that late back) puts /logout back with
 * history.replaceState, once; with no sheet entry pending no listener is added;
 * any listener is gone after it fires or when Leave unmounts.
 *
 * What is driven: the real Hatch, Sheet and Leave, mounted together by a small
 * host (the Hatch's onsignedout calls the Leave's descendFrom, as Home does).
 * Stood in: the router (a live `page.state`; `pushState` also writes
 * history.state['sveltekit:states'], where SvelteKit keeps it, so either way of
 * reading the pending entry sees it), Flight (its farewell beat is "descend()
 * then, a tick later, onfarewell()") and Dusk. history.back() is a controllable
 * fake: the test lands it by hand with `land()`. Timers are fake; nothing
 * depends on real time.
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
  url: new URL("http://localhost/settings"), params: {}, data: {}, status: 200, error: null, route: { id: null },
};
`;
const ROUTER_NAV = `export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {};
export const goto = async () => {}; export const replaceState = () => {};
export const invalidate = async () => {}; export const invalidateAll = async () => {};
export const pushState = (_url, state) => {
  const states = { ...(history.state?.["sveltekit:states"] ?? {}) };
  for (const [k, v] of Object.entries(state ?? {})) { globalThis.__router.entries.set(k, v); states[k] = v; }
  history.replaceState({ ...(history.state ?? {}), "sveltekit:states": states }, "", location.href);
};
`;
const WORKSPACE = `export const signOut = async () => null;
export const wordsOf = (_error, fallback) => fallback;
`;
const FLIGHT = `export default function Flight(_anchor, props) {
  return { readyWorld() {}, readyAtLeisure() { return () => {}; }, ascend() {}, descend() { setTimeout(() => props.onfarewell?.(), 0); } };
}
`;
const DUSK = "export default function Dusk() {}\n";
const HOST = `<script>
  import Hatch from "$lib/pocket/Hatch.svelte";
  import Leave from "$lib/flight/Leave.svelte";
  let leave;
</script>
<Hatch open={true} name="Emma Harlow" onsignedout={(to) => leave.descendFrom(to)} />
<Leave bind:this={leave} name="Emma Harlow" />
`;

describe("sign-out: a sheet back that lands after the 1.5 s cutoff (#1637)", () => {
  const loader = createPageLoader("sign-out-late-sheet-back", {
    stubs: {
      "$app/state": ROUTER_STATE,
      "$app/navigation": ROUTER_NAV,
      "$lib/data/workspace.js": WORKSPACE,
      "$lib/tour/watch.js": "export const watchTour = async () => {};\n",
      "lib/flight/Flight.svelte": FLIGHT,
      "lib/flight/Dusk.svelte": DUSK,
    },
  });
  const hostDir = mkdtempSync(join(tmpdir(), "late-back-host-"));
  const hostFile = join(hostDir, "Host.svelte");
  beforeAll(async () => {
    writeFileSync(hostFile, HOST);
    await loader.setup("lib/flight/Leave.svelte");
  });
  afterAll(() => {
    loader.teardown();
    rmSync(hostDir, { recursive: true, force: true });
  });

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
   * Starts at /settings, mounts Hatch + Leave (sheet open, so its entry is
   * pushed), and makes history.back() a fake that lands only when told to.
   */
  async function setUp() {
    router()?.entries.clear();
    window.history.replaceState({}, "", "/settings");
    await loader.mount(hostFile, {});
    expect(router().entries.has("pocketSheet"), "the sheet pushed its entry").toBe(true);
    let asked = 0;
    const back = vi.spyOn(window.history, "back").mockImplementation(() => { asked += 1; });
    undo.push(() => back.mockRestore());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    /** The back lands: the entry under the sheet's is now current, popstate, then the router's state clears. */
    const land = () => {
      expect(asked, "the sheet asked for a back").toBeGreaterThan(0);
      window.history.replaceState({}, "", "/settings");
      window.dispatchEvent(new Event("popstate"));
      router().entries.clear();
    };
    return { land };
  }

  /** Counts popstate listeners still registered: `leaked()` dispatches a popstate and returns how many ran. */
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

  it("ends on /logout when the sheet's back lands after the cutoff and the farewell", async () => {
    const { land } = await setUp();
    press();
    await vi.advanceTimersByTimeAsync(1600);
    expect(location.pathname, "the farewell has run").toBe("/logout");
    land();
    await vi.advanceTimersByTimeAsync(50);
    expect(location.pathname, "the late back left the address on the page under the sheet").toBe("/logout");
  });

  it("puts /logout back with replaceState, once, and a later Back behaves as today", async () => {
    const { land } = await setUp();
    const leaked = watchPopstate();
    press();
    await vi.advanceTimersByTimeAsync(1600);
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    undo.push(() => { push.mockRestore(); replace.mockRestore(); });
    land();
    await vi.advanceTimersByTimeAsync(50);
    const absorbed = replace.mock.calls.filter((call) => call[2] === "/logout").length;
    expect(absorbed, "the late pop was not answered with replaceState to /logout").toBe(1);
    expect(push, "the answer must never push").not.toHaveBeenCalled();
    expect(leaked(), "the listener was still registered after it fired").toBe(0);
    replace.mockClear();
    window.history.replaceState({}, "", "/settings");
    replace.mockClear();
    window.dispatchEvent(new Event("popstate"));
    expect(replace, "a Back pressed after the late back was absorbed was answered again").not.toHaveBeenCalled();
    expect(location.pathname).toBe("/settings");
  });

  it("with the back landing before the cutoff, ends on /logout and adds no listener", async () => {
    const { land } = await setUp();
    const leaked = watchPopstate();
    press();
    await vi.advanceTimersByTimeAsync(300);
    land();
    await vi.advanceTimersByTimeAsync(1600);
    expect(location.pathname, "the goodbye's address").toBe("/logout");
    expect(leaked(), "popstate listeners left registered after a normal sign-out").toBe(0);
  });

  it("adds no popstate listener for a sign-out from a desk menu (no sheet entry)", async () => {
    router()?.entries.clear();
    window.history.replaceState({}, "", "/settings");
    const { component } = await loader.mount("lib/flight/Leave.svelte", { name: "Emma Harlow" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const leaked = watchPopstate();
    await /** @type {any} */ (component).descendFrom(null);
    await vi.advanceTimersByTimeAsync(100);
    expect(location.pathname, "the farewell ran").toBe("/logout");
    expect(leaked(), "a desk sign-out registered a popstate listener").toBe(0);
  });

  it("removes the listener when Leave unmounts before the late back arrives", async () => {
    await setUp();
    const leaked = watchPopstate();
    press();
    await vi.advanceTimersByTimeAsync(1600);
    expect(location.pathname).toBe("/logout");
    loader.unmount();
    expect(leaked(), "a popstate listener outlived Leave").toBe(0);

  });
});
