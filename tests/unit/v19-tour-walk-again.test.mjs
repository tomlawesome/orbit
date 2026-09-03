// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTour } from "../../web/src/lib/tour/engine.js";
import { stopsFor } from "../../web/src/lib/tour/stops.js";
import {
  _resetTourRestartForTests,
  relaunchTour,
  requestTourRestart,
  tourMayBegin,
} from "../../web/src/lib/tour/relaunch.js";

/*
 * #753 (slice 3 of #477): "take the walk again" from settings.
 *
 * Tour.svelte's `started` flag is a one-shot per page load — right for
 * ordinary navigation, wrong here: a reader who clears `tourSeenAt` from
 * settings and lands back on /home in the SAME session must still get the
 * walk. relaunch.js is the seam that makes that ONE later arrival possible;
 * these tests drive it exactly the way the settings control and Tour.svelte's
 * arrival effect do, without mounting either component.
 */

const HOME = `
  <svg class="dial"><g class="chrome"></g><a class="sun-link"></a></svg>
  <div class="minisys"></div>
  <div class="hero-foot"></div>
  <div id="manifest-top"><div class="corridor"><div class="today"></div></div></div>
  <button id="nstar"></button>
  <button class="orb"></button>
  <div class="tourcard" tabindex="-1"><p id="tour-copy-1"></p><p id="tour-copy-2"></p></div>
`;

let fetched;

beforeEach(() => {
  document.body.innerHTML = HOME;
  fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
  _resetTourRestartForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  _resetTourRestartForTests();
});

describe("relaunchTour", () => {
  it("clears the record, then navigates home — in that order", async () => {
    const order = [];
    const clearTourSeen = vi.fn(async () => { order.push("clear"); });
    const navigateHome = vi.fn(async () => { order.push("navigate"); });

    await relaunchTour({ clearTourSeen, navigateHome });

    expect(clearTourSeen).toHaveBeenCalledTimes(1);
    expect(navigateHome).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["clear", "navigate"]);
  });

  it("arms the one-shot restart flag before either call resolves", async () => {
    expect(tourMayBegin(true)).toBe(false); // nothing requested yet
    let sawArmed = false;
    await relaunchTour({
      clearTourSeen: async () => { sawArmed = tourMayBegin(true); if (sawArmed) requestTourRestart(); },
      navigateHome: async () => {},
    });
    expect(sawArmed).toBe(true);
  });
});

describe("tourMayBegin — the guard Tour.svelte's arrival effect asks", () => {
  it("always lets a genuinely first arrival through", () => {
    expect(tourMayBegin(false)).toBe(true);
  });

  it("blocks a later arrival on the same load when nothing asked to relaunch", () => {
    expect(tourMayBegin(true)).toBe(false);
    expect(tourMayBegin(true)).toBe(false); // still false: not one-shot, just closed
  });

  it("lets exactly one arrival through after a relaunch is requested", () => {
    requestTourRestart();
    expect(tourMayBegin(true)).toBe(true);
    expect(tourMayBegin(true)).toBe(false); // the flag is consumed, not sticky
  });
});

describe("the clear-and-launch path, end to end", () => {
  /** Mirrors v19-tour-walk.test.mjs's own walk() helper. */
  function walk() {
    let route = "/settings";
    const navigated = [];
    const writes = [];
    const views = [];
    const tour = createTour({
      doc: document,
      stops: stopsFor(),
      routeOf: () => route,
      navigate: async (next) => { route = next; navigated.push(next); },
      writeSeen: async () => { writes.push(Date.now()); },
      onChange: (view) => views.push(view),
      patience: 20,
    });
    return { tour, navigated, writes, views, route: () => route };
  }

  it("starts the walk at stop 1 on the arrival that follows a relaunch", async () => {
    /* This is the guard a plain arrival hits: the reader already took (or
       skipped) the walk earlier this load, so `started` is already true. */
    const started = true;
    expect(tourMayBegin(started)).toBe(false);

    /* The settings control's own act. */
    const clearTourSeen = vi.fn(async () => ({ tourSeenAt: null }));
    const navigateHome = vi.fn(async () => {});
    await relaunchTour({ clearTourSeen, navigateHome });
    expect(clearTourSeen).toHaveBeenCalledTimes(1);
    expect(navigateHome).toHaveBeenCalledTimes(1);

    /* Tour.svelte's arrival effect, on landing back on /home. */
    expect(tourMayBegin(started)).toBe(true);
    const { tour, views, navigated } = walk();
    await tour.start();
    expect(navigated).toEqual(["/home"]);
    expect(views.at(-1)).toMatchObject({ id: "chart", number: 1, total: 8, first: true });

    /* And it is a one-shot: a THIRD arrival this load, with nothing new
       requested, does not get to start the walk again. */
    expect(tourMayBegin(started)).toBe(false);
  });

  it("never talks to a server on its own — clearTourSeen is the caller's job", async () => {
    const clearTourSeen = vi.fn(async () => ({ tourSeenAt: null }));
    await relaunchTour({ clearTourSeen, navigateHome: async () => {} });
    expect(fetched).not.toHaveBeenCalled();
  });
});

/*
 * The wiring itself — source checks, the walk test's own precedent for
 * behaviour that only shows up in a mounted Svelte component. Proves the
 * settings control and Tour.svelte's arrival effect actually call the
 * functions the tests above exercise, not just that the functions exist.
 */
describe("the wiring", () => {
  const tourSource = readFileSync(
    resolve(import.meta.dirname, "../../web/src/lib/tour/Tour.svelte"),
    "utf8",
  );
  const settingsSource = readFileSync(
    resolve(import.meta.dirname, "../../web/src/routes/settings/+page.svelte"),
    "utf8",
  );

  it("Tour.svelte's arrival effect asks tourMayBegin, not `started` alone", () => {
    expect(tourSource).toContain("tourMayBegin(started)");
  });

  it("the settings control clears the record and calls relaunchTour", () => {
    expect(settingsSource).toContain("clearTourSeen");
    expect(settingsSource).toContain("relaunchTour(");
    expect(settingsSource).toMatch(/take the walk again/);
  });
});
