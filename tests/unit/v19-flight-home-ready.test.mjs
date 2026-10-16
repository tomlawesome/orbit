import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1299: the descent never waits for its world, and the world was readied only
 * when sign-out was armed -- so it nearly always flew the fallback. Home now
 * readies it a few seconds after it has arrived, once its painted animations
 * are done, as orbit-site does on any page but the door.
 *
 * #1371: the world, its test frames, the GPU verdict and the unhurried
 * warming are the shared door's now (`journey.warm()`, `journey.later()`,
 * `gpu()`: the folder, unchanged). What stays Orbit's is WHEN to ask: which
 * pages ask, with what urgency, and never under reduced motion or save-data.
 * The pages are read as text (a `.svelte` file needs the compiler this suite
 * does not pull in); the one module that is plain JavaScript, fetch-ahead.js,
 * is run with the page stubbed.
 */
const read = (path) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");
const FLIGHT = read("web/src/lib/flight/Flight.svelte");
const LEAVE = read("web/src/lib/flight/Leave.svelte");
const HOME = read("web/src/routes/home/+page.svelte");
const ARRIVAL = read("web/src/lib/arrival/Arrival.svelte");
const SIGN_IN = read("web/src/lib/flight/SignIn.svelte");

/** @param {string} src @param {string} head */
const after = (src, head) => src.slice(src.indexOf(head));

describe("the pictures a page without a journey fetches ahead (fetch-ahead.js)", () => {
  /** @param {{ granted?: boolean, saveData?: boolean, reduced?: boolean }} [how] */
  function stubPage({ granted = true, saveData = false, reduced = false } = {}) {
    const fetchOnce = vi.fn(() => Promise.resolve());
    const hurryChores = vi.fn();
    const openChores = vi.fn();
    /* chores run at once: this test is about when the page asks, not the queue */
    const chore = vi.fn((fn) => Promise.resolve().then(fn));
    const gpu = vi.fn(() => (granted ? { parallel: true } : null));
    vi.doMock("$lib/door-host.js", () => ({
      chore, fetchOnce, hurryChores, openChores,
      image: (p) => `/img/${p}`, flightPictures: () => ["/img/flight/a.webp", "/img/flight/b.webp"],
    }));
    vi.doMock("$lib/gpu.js", () => ({ gpu }));
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { connection: { saveData } });
    vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
    return { fetchOnce, hurryChores, openChores, gpu };
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("$lib/door-host.js"); vi.doUnmock("$lib/gpu.js"); vi.resetModules(); });

  it("asks for the Earth's picture, then the flight's once the GPU verdict is in and the page may use it", async () => {
    const page = stubPage();
    const { fetchFlightAhead } = await import("$lib/flight/fetch-ahead.js");
    fetchFlightAhead();
    await settle();
    expect(page.fetchOnce.mock.calls.map((c) => c[0])).toEqual(["/img/dawn/dawn.webp", "/img/flight/a.webp", "/img/flight/b.webp"]);
    expect(page.gpu).toHaveBeenCalledOnce();
  });

  it("fetches none of the world's pictures where the page may not use the GPU", async () => {
    const page = stubPage({ granted: false });
    const { fetchFlightAhead } = await import("$lib/flight/fetch-ahead.js");
    fetchFlightAhead();
    await settle();
    expect(page.fetchOnce.mock.calls.map((c) => c[0])).toEqual(["/img/dawn/dawn.webp"]);
  });

  it("asks the GPU once however often it is called", async () => {
    const page = stubPage();
    const { fetchFlightAhead } = await import("$lib/flight/fetch-ahead.js");
    fetchFlightAhead();
    fetchFlightAhead({ hurry: true });
    await settle();
    expect(page.gpu).toHaveBeenCalledOnce();
    expect(page.fetchOnce).toHaveBeenCalledTimes(3);
  });

  it("opens the chores, or hurries the flight's when it is wanted now", async () => {
    const page = stubPage();
    const { fetchFlightAhead } = await import("$lib/flight/fetch-ahead.js");
    fetchFlightAhead();
    expect(page.openChores).toHaveBeenCalledOnce();
    expect(page.hurryChores).not.toHaveBeenCalled();
    fetchFlightAhead({ hurry: true });
    expect(page.hurryChores).toHaveBeenCalledWith("flight");
  });

  it("asks for nothing under save-data or reduced motion", async () => {
    for (const how of [{ saveData: true }, { reduced: true }]) {
      vi.resetModules();
      const page = stubPage(how);
      const { fetchFlightAhead } = await import("$lib/flight/fetch-ahead.js");
      fetchFlightAhead({ hurry: true });
      await settle();
      expect(page.fetchOnce).not.toHaveBeenCalled();
      expect(page.gpu).not.toHaveBeenCalled();
      expect(page.hurryChores).not.toHaveBeenCalled();
    }
  });
});

describe("the flight readies its world through the folder's journey (Flight.svelte)", () => {
  const ready = after(FLIGHT, "export function readyWorld(");

  it("decides whether to ask in ready-gate.js (tested as code in ready-gate.test.mjs), and returns at once when not", () => {
    expect(FLIGHT).toMatch(/import \{[^}]*\bmayReadyWorld\b[^}]*\} from "\.\/ready-gate\.js";/u);
    expect(ready).toMatch(/if \(!journey \|\| !mayReadyWorld\(\{ journey: true, reduced: reduced\(\), gentle, compile, savingData, compilesAside \}\)\) return Promise\.resolve\(\);/u);
  });

  it("asks the folder's journey for the world, hurried or not", () => {
    expect(ready).toMatch(/if \(hurry\) hurryChores\("flight"\); else openChores\(\);/u);
    expect(ready).toMatch(/return journey\.warm\(\{ prove \}\)/u);
  });

  it("the climb readies it hurried, with the test frames, and holds on it; a pinned climb waits for nothing", () => {
    expect(FLIGHT).toMatch(/const ready = reduced\(\) \|\| pinned \? null : readyWorld\(\{ hurry: true \}\);/u);
  });

  it("the descent asks for nothing: it flies the world if it is proved, and painted if not", () => {
    const descend = after(FLIGHT, "export function descend(").slice(0, 700);
    expect(descend).not.toMatch(/readyWorld|\.warm\(/u);
  });

  it("the unhurried ask goes through ready-gate.js's readyWorldAtLeisure, readying through readyWorld (its behaviour is in ready-gate.test.mjs)", () => {
    expect(FLIGHT).toMatch(/import \{[^}]*\breadyWorldAtLeisure\b[^}]*\} from "\.\/ready-gate\.js";/u);
    const leisure = after(FLIGHT, "export function readyAtLeisure(").split("\n  /**")[0];
    expect(leisure).toMatch(/return readyWorldAtLeisure\(\{ journey, reduced: reduced\(\), savingData: savingData\(\), ready: readyWorld, how \}\);/u);
    /* no timer of Orbit's own: the folder's later() drops it when a descent begins */
    expect(leisure).not.toMatch(/setTimeout|requestIdleCallback/u);
  });
});

describe("home and the menus ask for it (#1299)", () => {
  it("Leave readies the descent's world, hurried and gently, when a menu opens", () => {
    expect(after(LEAVE, "export function ready()")).toMatch(/flight\?\.readyWorld\(\{ hurry: true, gentle: true \}\)/u);
    expect(HOME).toMatch(/const readyDescent = \(\) => leave\?\.ready\(\);/u);
  });

  it("home asks at leisure on mount, except on a launch, whose climb readies its own world; and stops if home is left", () => {
    expect(HOME).toMatch(/onMount\(\(\) => \(launching \? undefined : leave\?\.readyAtLeisure\(\)\)\);/u);
    expect(after(LEAVE, "export function readyAtLeisure(")).toMatch(/return flight\?\.readyAtLeisure\(how\);/u);
  });
});

describe("the arrival asks once it knows a launch is owed (#1222)", () => {
  it("fetches the flight's pictures at once, hurried, while the session is still being asked", () => {
    expect(ARRIVAL).toMatch(/if \(launchOwed\) fetchFlightAhead\(\{ hurry: true \}\);/u);
  });

  it("mounts the flight and readies its world, test frames and all, when the session says the reader flies here", () => {
    expect(ARRIVAL).toMatch(/\{#if climbing \|\| flying\}/u);
    const decide = after(ARRIVAL, "if (launchOwed) {\n        flying = true;");
    expect(decide.slice(0, 260)).toMatch(/await tick\(\);[\s\S]*flight\?\.readyWorld\(\{ hurry: true, gentle: true \}\);/u);
  });
});

describe("the door has no journey, so it fetches the flight's pictures and compiles nothing (#1299)", () => {
  it("asks for them once the door is lit and its reveal done (the folder's onOpen), and once the door can open", () => {
    expect(SIGN_IN).toMatch(/onOpen: \(\) => \{ opened = true; ask\(\); \}/u);
    expect(SIGN_IN).toMatch(/function readyWhenDrawn\(\) \{\s*wanted = true;\s*ask\(\);/u);
    expect(SIGN_IN).toMatch(/fetchFlightAhead\(\);/u);
  });

  it("the sign-in's press hurries them", () => {
    expect(SIGN_IN).toMatch(/fetchFlightAhead\(\{ hurry: true \}\);/u);
  });

  it("holds the ring for no compile", () => {
    expect(SIGN_IN).not.toMatch(/compileStopsPage|compileFlightNow|behindRing/u);
  });
});
