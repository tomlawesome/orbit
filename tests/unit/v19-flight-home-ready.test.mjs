import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1299: the descent never waits for its world, and the world was readied only
 * when sign-out was armed -- so it nearly always flew the fallback. Home now
 * readies it a few seconds after it has arrived, once its painted animations
 * are done, as orbit-site does on any page but the door. Shaped like
 * v19-flight-gpu-verdict.test.mjs (stub the page, reset modules per test).
 */
function stubPage({ parallel = true, saveData = false, reduced = false, animations = [] } = {}) {
  const gpu = vi.fn(() => ({ parallel }));
  const warm = vi.fn(() => Promise.resolve());
  const voyageOnce = vi.fn(() => ({ warm }));
  const fetchVoyage = vi.fn();
  const fetchOnce = vi.fn(() => Promise.resolve());
  const hurryChores = vi.fn();
  const openChores = vi.fn();
  /* chores run at once: this test is about when home asks, not the queue */
  const chore = vi.fn((fn) => Promise.resolve().then(fn));
  vi.doMock("$lib/flight/chores.js", () => ({ chore, fetchOnce, hurryChores, openChores }));
  vi.doMock("$lib/flight/voyage.js", () => ({ fetchVoyage, voyageOnce }));
  vi.doMock("$lib/flight/fitness.js", () => ({ gpu }));
  vi.stubGlobal("document", { getAnimations: () => animations });
  vi.stubGlobal("navigator", { connection: { saveData } });
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  return { gpu, warm, voyageOnce, fetchVoyage, hurryChores, openChores };
}

/** a painted animation (its property is not compositor-only) that ends when told */
function paintedAnimation() {
  let end;
  const finished = new Promise((r) => { end = r; });
  return {
    end,
    animation: {
      effect: { target: {}, getComputedTiming: () => ({ endTime: 1000 }), getKeyframes: () => [{ filter: "blur(4px)" }] },
      finished,
    },
  };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock("$lib/flight/chores.js"); vi.doUnmock("$lib/flight/voyage.js"); vi.doUnmock("$lib/flight/fitness.js"); vi.resetModules(); });

describe("home readies the flight's world once it has arrived (#1299)", () => {
  it("does nothing at first, then readies it, gently and without test frames, after orbit-site's 4 s", async () => {
    const page = stubPage();
    const { readyFlightAtLeisure } = await import("$lib/flight/warm.js");
    readyFlightAtLeisure();
    await vi.advanceTimersByTimeAsync(3900);
    expect(page.gpu).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(page.gpu).toHaveBeenCalledOnce();
    expect(page.voyageOnce).toHaveBeenCalledOnce();
    expect(page.warm).toHaveBeenCalledWith({ prove: false });
    /* unhurried: the chores begin, but nothing is rushed */
    expect(page.hurryChores).not.toHaveBeenCalled();
    expect(page.openChores).toHaveBeenCalled();
  });

  it("waits for the painted animations to finish before it asks", async () => {
    const drawing = paintedAnimation();
    const page = stubPage({ animations: [drawing.animation] });
    const { readyFlightAtLeisure } = await import("$lib/flight/warm.js");
    readyFlightAtLeisure();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(page.gpu).not.toHaveBeenCalled();
    drawing.end();
    await settle();
    expect(page.gpu).toHaveBeenCalledOnce();
  });

  it("asks nothing when the page is left first", async () => {
    const page = stubPage();
    const { readyFlightAtLeisure } = await import("$lib/flight/warm.js");
    const stop = readyFlightAtLeisure();
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(page.gpu).not.toHaveBeenCalled();
  });

  it("makes no world where compiling would stop the page (no parallel compile), as the door does", async () => {
    const page = stubPage({ parallel: false });
    const { readyFlightAtLeisure } = await import("$lib/flight/warm.js");
    readyFlightAtLeisure();
    await vi.advanceTimersByTimeAsync(4100);
    await settle();
    expect(page.gpu).toHaveBeenCalledOnce();
    expect(page.voyageOnce).not.toHaveBeenCalled();
  });

  it.each([["save-data", { saveData: true }], ["reduced motion", { reduced: true }]])("asks nothing under %s", async (_name, how) => {
    const page = stubPage(how);
    const { readyFlightAtLeisure } = await import("$lib/flight/warm.js");
    readyFlightAtLeisure();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(page.gpu).not.toHaveBeenCalled();
  });

  it("does not ready twice when the sign-out has already started it", async () => {
    const page = stubPage();
    const { readyFlight, readyFlightAtLeisure } = await import("$lib/flight/warm.js");
    readyFlight({ hurry: true, gentle: true });
    readyFlightAtLeisure();
    await vi.advanceTimersByTimeAsync(4100);
    await settle();
    expect(page.gpu).toHaveBeenCalledOnce();
    expect(page.voyageOnce).toHaveBeenCalledOnce();
  });
});

describe("home asks for it (#1299)", () => {
  const HOME = readFileSync(resolve(import.meta.dirname, "../../web/src/routes/home/+page.svelte"), "utf8");
  it("on mount, except on a launch, whose climb readies its own world; and stops if home is left", () => {
    expect(HOME).toMatch(/import \{ readyFlightAtLeisure \} from "\$lib\/flight\/warm\.js";/u);
    expect(HOME).toMatch(/onMount\(\(\) => \(launching \? undefined : readyFlightAtLeisure\(\)\)\);/u);
  });
});
