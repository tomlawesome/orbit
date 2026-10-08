import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKSTOP_MS, COMPILE_CAP_MS, GRACE_MS, MAX_LAPS, SEEN_FRESH_MS, SEEN_KEY, isFirstVisit, startFirstLight, within,
} from "../../web/src/lib/flight/first-light.js";

/* #1253: first light is orbit-site's (main.js showDoor): `lit` waits for the
   pieces and, on a first visit, a lap of the runner, and never for ever. */

/** @param {Record<string, string>} [kept] */
const storage = (kept = {}) => ({
  getItem: (/** @type {string} */ k) => kept[k] ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => { kept[k] = v; },
});

describe("a first visit", () => {
  it("is a browser that has not seen the door, and records the visit", () => {
    const s = storage();
    expect(isFirstVisit(s, 1000)).toBe(true);
    expect(isFirstVisit(s, 2000)).toBe(false);
  });

  it("comes again after 36 hours", () => {
    const s = storage({ [SEEN_KEY]: "0" });
    expect(isFirstVisit(s, SEEN_FRESH_MS)).toBe(false);
    expect(isFirstVisit(s, SEEN_FRESH_MS * 2 + 1)).toBe(true);
  });

  it("is what a browser that will not say gets", () => {
    expect(isFirstVisit(undefined)).toBe(true);
    expect(isFirstVisit({ getItem() { throw new Error("no"); }, setItem() {} })).toBe(true);
  });
});

describe("waiting for first light", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (/** @type {() => void} */ fn) => setTimeout(fn, 16));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** @param {{ minLaps?: number, animated?: boolean, runner?: boolean }} [o] */
  function door({ minLaps = 0, animated = true, runner = true } = {}) {
    let resolve = () => {};
    const critical = new Promise((r) => { resolve = () => r(undefined); });
    const target = new EventTarget();
    const calls = /** @type {string[]} */ ([]);
    const stop = startFirstLight({
      critical, runner: runner ? target : null, minLaps,
      loading: () => calls.push("loading"), animated: () => animated, light: () => calls.push("light"),
    });
    const lap = () => target.dispatchEvent(new Event("animationiteration"));
    return { resolve, lap, calls, stop };
  }

  it("lights at once when everything is already there and no lap is owed", async () => {
    const d = door();
    d.resolve();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["light"]);
  });

  it("shows the runner when the pieces are late, and lights at the end of the lap they were awaited in", async () => {
    const d = door();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 10);
    expect(d.calls).toEqual(["loading"]);
    d.lap();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading"]);
    d.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(d.calls).toEqual(["loading"]);
    d.lap();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading", "light"]);
  });

  it("runs a whole lap first on a first visit, even with everything there", async () => {
    const d = door({ minLaps: 1 });
    d.resolve();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 10);
    expect(d.calls).toEqual(["loading"]);
    d.lap();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading", "light"]);
  });

  it("lights after seven laps whatever has not come", async () => {
    const d = door();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 10);
    for (let i = 0; i < MAX_LAPS; i++) d.lap();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading", "light"]);
  });

  it("lights at the backstop if the runner never laps", async () => {
    const d = door();
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS + GRACE_MS + 100);
    expect(d.calls).toEqual(["loading", "light"]);
  });

  it("without the runner's motion, lights on the pieces alone", async () => {
    const d = door({ minLaps: 1, animated: false });
    await vi.advanceTimersByTimeAsync(GRACE_MS + 10);
    expect(d.calls).toEqual(["loading"]);
    d.resolve();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading", "light"]);
  });

  it("lights once, and not at all after it is stopped", async () => {
    const d = door({ minLaps: 1 });
    d.resolve();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 10);
    d.lap(); d.lap();
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS + GRACE_MS + 100);
    expect(d.calls.filter((c) => c === "light")).toHaveLength(1);
    const e = door({ minLaps: 1 });
    e.resolve();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 10);
    e.stop();
    e.lap();
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS + GRACE_MS + 100);
    expect(e.calls).toEqual(["loading"]);
  });

  it("treats a piece that fails as arrived", async () => {
    const d = door();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 10);
    await expect(within(Promise.reject(new Error("no")), 10)).resolves.toBeUndefined();
    d.stop();
  });
});

/* #1299: where shaders compile on the page's own thread (Firefox, Safari) the
   ring runs on while they are compiled behind it, as the site's `waitCompiled`
   does, for at most 9 s. */
describe("waiting for first light with the flight's shaders compiling behind the ring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (/** @type {() => void} */ fn) => setTimeout(fn, 16));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function door() {
    const target = new EventTarget();
    const calls = /** @type {string[]} */ ([]);
    let compiled = () => {};
    const compile = vi.fn(() => { calls.push("compile"); return new Promise((r) => { compiled = () => r(undefined); }); });
    startFirstLight({
      critical: Promise.resolve(), runner: target, minLaps: 1, compile,
      loading: () => calls.push("loading"), animated: () => true, light: () => calls.push("light"),
    });
    const lap = () => target.dispatchEvent(new Event("animationiteration"));
    return { calls, compile, lap, compiled: () => compiled() };
  }

  it("compiles only once the ring is up and running, and lights only after it is done", async () => {
    const d = door();
    /* the ring is shown first; the compile is two frames behind it */
    await vi.advanceTimersByTimeAsync(10);
    expect(d.calls).toEqual(["loading"]);
    await vi.advanceTimersByTimeAsync(60);
    expect(d.calls).toEqual(["loading", "compile"]);
    d.lap();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading", "compile"]);
    d.compiled();
    await vi.advanceTimersByTimeAsync(10);
    d.lap();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading", "compile", "light"]);
  });

  it("stops waiting for the compile after 9 s", async () => {
    const d = door();
    await vi.advanceTimersByTimeAsync(GRACE_MS + 100 + COMPILE_CAP_MS + 10);
    d.lap();
    await vi.advanceTimersByTimeAsync(40);
    expect(d.calls).toEqual(["loading", "compile", "light"]);
  });

  it("a compile that throws does not hold the door", async () => {
    const target = new EventTarget();
    const calls = /** @type {string[]} */ ([]);
    startFirstLight({
      critical: Promise.resolve(), runner: target, minLaps: 1, compile: () => { throw new Error("no"); },
      loading: () => calls.push("loading"), animated: () => true, light: () => calls.push("light"),
    });
    await vi.advanceTimersByTimeAsync(GRACE_MS + 100);
    target.dispatchEvent(new Event("animationiteration"));
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toEqual(["loading", "light"]);
  });
});
