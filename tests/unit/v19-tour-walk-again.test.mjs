// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetTourRestartForTests,
  onRestartInPlace,
  relaunchTour,
  requestTourRestart,
  tourMayBegin,
} from "../../web/src/lib/tour/relaunch.js";
import { beginFilm } from "../../web/src/lib/tour/trigger.js";

/*
 * #753 (slice 3 of #477): "take the walk again" from settings — now
 * relaunching the one-take film (#866) rather than the superseded eight-stop
 * card walk (owner-decisions.md §23).
 *
 * Tour.svelte's `started` flag is a one-shot per page load — right for
 * ordinary navigation, wrong here: a reader who clears `tourSeenAt` from
 * settings and lands back on /home in the SAME session must still get the
 * film. relaunch.js is the seam that makes that ONE later arrival possible;
 * these tests drive it exactly the way the settings control and Tour.svelte's
 * arrival effect do, without mounting either component.
 */

let fetched;

beforeEach(() => {
  fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
  _resetTourRestartForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  it("starts the film on the arrival that follows a relaunch, on a desk", async () => {
    /* This is the guard a plain arrival hits: the reader already took (or
       skipped) the film earlier this load, so `started` is already true. */
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
    const start = vi.fn(async () => {});
    const outcome = await beginFilm({
      phone: false,
      readTour: async () => ({ tourSeenAt: null }),
      hasHousehold: () => true,
      createFilmRun: () => ({ player: { onEnd: () => () => {} }, start }),
      writeSeen: () => {},
    });
    expect(outcome).toBe("started");
    expect(start).toHaveBeenCalledTimes(1);

    /* And it is a one-shot: a THIRD arrival this load, with nothing new
       requested, does not get to start the film again. */
    expect(tourMayBegin(started)).toBe(false);
  });

  it("never talks to a server on its own — clearTourSeen is the caller's job", async () => {
    const clearTourSeen = vi.fn(async () => ({ tourSeenAt: null }));
    await relaunchTour({ clearTourSeen, navigateHome: async () => {} });
    expect(fetched).not.toHaveBeenCalled();
  });
});

/*
 * #1189: "Watch the tour" now sits in both account menus, which are open on
 * /home itself. Navigating to /home from /home changes nothing Tour.svelte's
 * arrival effect watches, so the film would never start. Already home, the
 * relaunch signals Tour.svelte in place instead of navigating.
 */
describe("relaunchTour from /home itself (#1189)", () => {
  beforeEach(() => _resetTourRestartForTests());

  it("signals in place, after the record is cleared, instead of navigating", async () => {
    const order = [];
    const stop = onRestartInPlace(() => order.push("signal"));
    await relaunchTour({
      clearTourSeen: async () => order.push("clear"),
      navigateHome: async () => order.push("navigate"),
      onHome: () => true,
    });
    stop();
    expect(order).toEqual(["clear", "signal"]);
    // The signal still has to get past Tour.svelte's one-shot guard.
    expect(tourMayBegin(true)).toBe(true);
  });

  it("navigates as before from anywhere else, and signals nothing", async () => {
    const order = [];
    const stop = onRestartInPlace(() => order.push("signal"));
    await relaunchTour({
      clearTourSeen: async () => order.push("clear"),
      navigateHome: async () => order.push("navigate"),
      onHome: () => false,
    });
    stop();
    expect(order).toEqual(["clear", "navigate"]);
  });

  it("stops signalling a listener once it unsubscribes", async () => {
    const heard = vi.fn();
    onRestartInPlace(heard)();
    await relaunchTour({ clearTourSeen: async () => {}, navigateHome: async () => {}, onHome: () => true });
    expect(heard).not.toHaveBeenCalled();
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

  it("Tour.svelte's arrival effect asks tourMayBegin, not `started` alone", () => {
    expect(tourSource).toContain("tourMayBegin(started)");
  });

  it("Tour.svelte listens for a restart in place", () => {
    expect(tourSource).toContain("onRestartInPlace(");
  });

  /* #1189 (owner decision 2026-10-02): one label, four places. */
  it.each([
    "web/src/routes/settings/+page.svelte",
    "web/src/routes/settings/pocket.svelte",
    "web/src/lib/Chrome.svelte",
    "web/src/lib/pocket/Hatch.svelte",
  ])("%s offers \"watch the tour\" through watchTour", (path) => {
    const source = readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");
    expect(source).toContain("watchTour");
    expect(source).toMatch(/>\s*↻ watch the tour\s*</u);
    expect(source).not.toMatch(/take the walk again</u);
  });

  it("watchTour clears the record and calls relaunchTour", () => {
    const watchSource = readFileSync(resolve(import.meta.dirname, "../../web/src/lib/tour/watch.js"), "utf8");
    expect(watchSource).toContain("clearTourSeen");
    expect(watchSource).toContain("relaunchTour(");
  });
});
