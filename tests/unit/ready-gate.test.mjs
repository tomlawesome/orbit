import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEISURE_ASK, mayReadyWorld, readyWorldAtLeisure } from "../../web/src/lib/flight/ready-gate.js";

/*
 * #1299, #1371: WHEN the flight's world is asked for, run as code (the same
 * truth table as the old warm.js test at 2d927354, where the decision lived
 * in a plain module). The world itself, its test frames and the unhurried
 * wait are the shared door's; what is Orbit's is whether to ask and how.
 */

/** @param {Partial<Parameters<typeof mayReadyWorld>[0]> & { saveData?: boolean, aside?: boolean }} [how] */
const may = ({ saveData = false, aside = true, ...rest } = {}) =>
  mayReadyWorld({
    journey: true, reduced: false, gentle: false, compile: false,
    savingData: () => saveData, compilesAside: () => aside, ...rest,
  });

describe("whether readyWorld asks the folder for the world", () => {
  it("asks for the flight's own (not gentle) ask wherever the browser compiles, and under save-data", () => {
    expect(may()).toBe(true);
    expect(may({ aside: false })).toBe(true);
    expect(may({ saveData: true })).toBe(true);
  });

  it("never asks with no journey, or under reduced motion, whatever else is said", () => {
    for (const gentle of [false, true]) {
      for (const compile of [false, true]) {
        expect(may({ journey: false, gentle, compile }), `no journey ${gentle} ${compile}`).toBe(false);
        expect(may({ reduced: true, gentle, compile }), `reduced ${gentle} ${compile}`).toBe(false);
      }
    }
  });

  it("a gentle ask asks where the compile is made off the page's thread", () => {
    expect(may({ gentle: true, aside: true })).toBe(true);
  });

  it("a gentle ask holds off where the compile would stop the page, unless a quiet moment was chosen (compile)", () => {
    expect(may({ gentle: true, aside: false })).toBe(false);
    expect(may({ gentle: true, aside: false, compile: true })).toBe(true);
  });

  it("a gentle ask holds off under save-data, even with a quiet moment chosen", () => {
    for (const aside of [true, false]) {
      for (const compile of [false, true]) {
        expect(may({ gentle: true, saveData: true, aside, compile }), `${aside} ${compile}`).toBe(false);
      }
    }
  });

  it("reads save-data and the compile only for a gentle ask (they may be costly or stateful)", () => {
    const savingData = vi.fn(() => false);
    const compilesAside = vi.fn(() => true);
    mayReadyWorld({ journey: true, reduced: false, gentle: false, compile: false, savingData, compilesAside });
    expect(savingData).not.toHaveBeenCalled();
    expect(compilesAside).not.toHaveBeenCalled();
  });
});

describe("the unhurried ask (readyWorldAtLeisure)", () => {
  /** a journey whose later() keeps the work, to be run or dropped by the test */
  const fakeJourney = () => {
    const stop = vi.fn();
    const kept = [];
    return { stop, kept, later: vi.fn((fn, how) => { kept.push({ fn, how }); return stop; }) };
  };

  it("proves the world: when it runs it asks gently, for a quiet moment, with the test frames (a descent draws the world only once proved)", () => {
    const journey = fakeJourney();
    const ready = vi.fn();
    readyWorldAtLeisure({ journey, reduced: false, savingData: false, ready });
    expect(ready).not.toHaveBeenCalled();
    journey.kept[0].fn();
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][0]).toEqual({ gentle: true, compile: true, prove: true });
    expect(LEISURE_ASK.prove).toBe(true);
  });

  it("hands the wait to the folder's later(), and gives its stop back", () => {
    const journey = fakeJourney();
    const stop = readyWorldAtLeisure({ journey, reduced: false, savingData: false, ready: vi.fn(), how: { after: 1234 } });
    expect(journey.later).toHaveBeenCalledOnce();
    expect(journey.kept[0].how).toEqual({ after: 1234 });
    expect(stop).toBe(journey.stop);
  });

  it.each([
    ["no journey", { journey: null }],
    ["reduced motion", { reduced: true }],
    ["save-data", { savingData: true }],
  ])("asks nothing, and gives a harmless stop, under %s", (_name, how) => {
    const journey = fakeJourney();
    const ready = vi.fn();
    const stop = readyWorldAtLeisure({ journey, reduced: false, savingData: false, ready, ...how });
    expect(journey.later).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});

describe("a descent beginning drops the leisure ask (the folder's journey, run for real)", () => {
  /* The folder (web/src/lib/door/journey.js) owns this, and Orbit's part is to
     ask through journey.later() rather than a timer of its own. Run the real
     journey with the browser's pieces stubbed, and the real gate asking it. */
  /** @type {any} */ let createJourney;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const classes = new Set();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("addEventListener", () => {});
    vi.stubGlobal("removeEventListener", () => {});
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("document", {
      body: { classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) } },
      getAnimations: () => [],
      createTextNode: (text) => ({ text }),
      createElement: () => ({}),
    });
    /* the one piece that needs a GPU: the flight's engine, made empty */
    vi.doMock("../../web/src/lib/door/engine.js", async (original) => ({
      ...(await original()),
      createFlight: () => ({ resize() {}, destroy() {}, warm: () => Promise.resolve(), warmDocs: () => Promise.resolve(), compiled: () => Promise.resolve() }),
    }));
    ({ createJourney } = await import("../../web/src/lib/door/journey.js"));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock("../../web/src/lib/door/engine.js"); vi.resetModules(); });

  const make = () => createJourney({
    canvas: {}, name: { replaceChildren() {} }, dawnGlyph: () => null, duskGlyph: () => null,
  });

  it("runs the ask after its wait when nothing begins first", async () => {
    const journey = make();
    const ready = vi.fn();
    readyWorldAtLeisure({ journey, reduced: false, savingData: false, ready });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ready).toHaveBeenCalledOnce();
    expect(ready.mock.calls[0][0].prove).toBe(true);
  });

  it("never runs it when a descent begins within the wait", async () => {
    const journey = make();
    const ready = vi.fn();
    readyWorldAtLeisure({ journey, reduced: false, savingData: false, ready });
    await vi.advanceTimersByTimeAsync(2000);
    journey.descend({});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ready).not.toHaveBeenCalled();
  });

  it("never runs it when a flight begins within the wait", async () => {
    const journey = make();
    const ready = vi.fn();
    readyWorldAtLeisure({ journey, reduced: false, savingData: false, ready });
    await vi.advanceTimersByTimeAsync(2000);
    journey.ascend({});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ready).not.toHaveBeenCalled();
  });
});
