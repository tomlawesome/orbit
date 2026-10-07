import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1299: the dial's sun (furnace.js) kept drawing behind the whole descent.
 * It pauses when it scrolls off screen or the tab is hidden, but a sign-out
 * hides home with opacity and then visibility (home.css, body.dispersing),
 * which neither check notices, so the shader ran on under the dusk. It now
 * stops once the sign-out has hidden it -- not before, while the page is
 * still fading -- and lights again if the sign-out is undone or the page
 * comes back from the back-forward cache.
 *
 * Shaped like v19-flight-home-ready.test.mjs: stub the page, reset modules
 * per test, mock fitness.js's GPU verdict.
 */

function stubPage() {
  const page = {
    visibility: "visible",
    draws: 0,
    /** @type {Array<() => void>} */
    frames: [],
    /** @type {Map<string, Set<Function>>} */
    docListeners: new Map(),
    /** @type {Map<string, Set<Function>>} */
    winListeners: new Map(),
    /** @type {Array<{ cb: Function, target: unknown }>} */
    mutations: [],
    /** @type {Function | null} */
    intersect: null,
  };
  const on = (map) => (type, fn) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); };
  const off = (map) => (type, fn) => map.get(type)?.delete(fn);
  const body = { tag: "body" };
  const root = { dataset: { theme: "starchart" } };
  vi.stubGlobal("document", {
    hidden: false, body, documentElement: root,
    addEventListener: on(page.docListeners), removeEventListener: off(page.docListeners),
  });
  vi.stubGlobal("addEventListener", on(page.winListeners));
  vi.stubGlobal("removeEventListener", off(page.winListeners));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: page.visibility }));
  vi.stubGlobal("requestAnimationFrame", (fn) => { page.frames.push(fn); return page.frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => { page.frames = []; });
  vi.stubGlobal("IntersectionObserver", class { constructor(cb) { page.intersect = cb; } observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class {
    constructor(cb) { this.cb = cb; }
    observe(target) { page.mutations.push({ cb: this.cb, target }); }
    disconnect() { page.mutations = page.mutations.filter((m) => m.cb !== this.cb); }
  });
  vi.doMock("$lib/flight/fitness.js", () => ({ gpu: () => ({ parallel: true }) }));

  const gl = new Proxy({ VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, TRIANGLES: 7 }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "drawArrays") return () => { page.draws++; };
      if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
      if (key === "getExtension") return () => null;
      return () => ({});
    },
  });
  const canvas = { width: 0, height: 0, getContext: () => gl, addEventListener() {} };
  const box = { clientWidth: 40, classList: { add() {}, remove() {} } };

  return {
    page, canvas, box,
    /** run `n` animation frames */
    run(n = 3) { for (let i = 0; i < n; i++) { const due = page.frames; page.frames = []; for (const fn of due) fn(); } },
    /** the body's class changed (the sign-out's beats, or a reset) */
    classChanged() { for (const m of page.mutations.filter((x) => x.target === body)) m.cb([]); },
    /** a transition ended somewhere on the page */
    transitionEnded(propertyName) { for (const fn of page.docListeners.get("transitionend") ?? []) fn({ propertyName }); },
    fire(map, type) { for (const fn of map.get(type) ?? []) fn({ persisted: true }); },
  };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("$lib/flight/fitness.js"); });

describe("the sun stops drawing under a sign-out (#1299)", () => {
  it("draws while the page fades, and stops once the sign-out has hidden it", async () => {
    const t = stubPage();
    const { mountFurnace } = await import("$lib/sun/furnace.js");
    mountFurnace(/** @type {any} */ (t.box), /** @type {any} */ (t.canvas));
    t.page.intersect?.([{ isIntersecting: true }]);
    t.run();
    const lit = t.page.draws;
    expect(lit).toBeGreaterThan(1);

    /* the descent begins: the page is still fading, so the sun still draws */
    t.classChanged();
    t.run();
    expect(t.page.draws).toBeGreaterThan(lit);

    /* the fade is over and the page is hidden */
    t.page.visibility = "hidden";
    t.transitionEnded("visibility");
    const hidden = t.page.draws;
    t.run(10);
    expect(t.page.draws).toBe(hidden);
    expect(t.page.frames).toEqual([]);
  });

  it("other transitions ending do not make it look again", async () => {
    const t = stubPage();
    const { mountFurnace } = await import("$lib/sun/furnace.js");
    mountFurnace(/** @type {any} */ (t.box), /** @type {any} */ (t.canvas));
    t.page.intersect?.([{ isIntersecting: true }]);
    t.page.visibility = "hidden";
    t.transitionEnded("opacity");
    t.run();
    expect(t.page.draws).toBeGreaterThan(1);
  });

  it("lights again when the sign-out is undone (its classes cleared)", async () => {
    const t = stubPage();
    const { mountFurnace } = await import("$lib/sun/furnace.js");
    mountFurnace(/** @type {any} */ (t.box), /** @type {any} */ (t.canvas));
    t.page.intersect?.([{ isIntersecting: true }]);
    t.page.visibility = "hidden";
    t.classChanged();
    t.run();
    const hidden = t.page.draws;
    t.page.visibility = "visible";
    t.classChanged();
    t.run();
    expect(t.page.draws).toBeGreaterThan(hidden);
  });

  it("lights again when the page comes back from the back-forward cache, and only if it can be seen", async () => {
    const t = stubPage();
    const { mountFurnace } = await import("$lib/sun/furnace.js");
    mountFurnace(/** @type {any} */ (t.box), /** @type {any} */ (t.canvas));
    t.page.intersect?.([{ isIntersecting: true }]);
    /* put away: the tab is hidden as the page is frozen */
    /** @type {any} */ (document).hidden = true;
    t.fire(t.page.docListeners, "visibilitychange");
    t.run();
    const away = t.page.draws;
    /* restored, still behind a finished sign-out: stays dark */
    /** @type {any} */ (document).hidden = false;
    t.page.visibility = "hidden";
    t.fire(t.page.winListeners, "pageshow");
    t.run();
    expect(t.page.draws).toBe(away);
    /* restored with home showing: draws */
    t.page.visibility = "visible";
    t.fire(t.page.winListeners, "pageshow");
    t.run();
    expect(t.page.draws).toBeGreaterThan(away);
  });

  it("lets go of everything it listens to when the sun goes", async () => {
    const t = stubPage();
    const { mountFurnace } = await import("$lib/sun/furnace.js");
    const stop = mountFurnace(/** @type {any} */ (t.box), /** @type {any} */ (t.canvas));
    stop();
    expect(t.page.docListeners.get("transitionend")?.size ?? 0).toBe(0);
    expect(t.page.winListeners.get("pageshow")?.size ?? 0).toBe(0);
    expect(t.page.mutations).toEqual([]);
  });
});
