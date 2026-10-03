// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { beginFilm } from "../../web/src/lib/tour/trigger.js";

/*
 * #866: replacing the superseded eight-stop card walk with the one-take film
 * — owner-decisions.md §23 ("the only tour is the one with the play and
 * pause buttons") and §24 (2026-09-23, a phone waits rather than seeing the
 * old walk).
 *
 * beginFilm (trigger.js) is Tour.svelte's gate, extracted framework-free like
 * relaunch.js's own seam so every branch is driven by a unit test without a
 * mounted component. These tests drive it exactly the way Tour.svelte's
 * arrival effect does, with fakes standing in for readTour, the household
 * check and the film itself.
 */

/** A fake film whose player can be told to end, exactly once per test. */
function fakeFilmRun() {
  const endCbs = [];
  const start = vi.fn(async () => {});
  return {
    start,
    player: {
      onEnd(cb) {
        endCbs.push(cb);
        return () => { const at = endCbs.indexOf(cb); if (at >= 0) endCbs.splice(at, 1); };
      },
    },
    /** Simulates player.js's `finish`/`stop`, both of which fire `onEnd(true)`. */
    end() {
      for (const cb of [...endCbs]) cb(true);
    },
  };
}

describe("beginFilm — desk, first ever arrival, a household present", () => {
  it("starts the film", async () => {
    const run = fakeFilmRun();
    const createFilmRun = vi.fn(() => run);
    const outcome = await beginFilm({
      readTour: async () => ({ tourSeenAt: null }),
      hasHousehold: () => true,
      createFilmRun,
      writeSeen: () => {},
    });
    expect(outcome).toBe("started");
    expect(createFilmRun).toHaveBeenCalledTimes(1);
    expect(run.start).toHaveBeenCalledTimes(1);
  });
});

describe("beginFilm — a pocket viewport (#1083, ending §24)", () => {
  it("starts the film and writes once on end, the same as a desk arrival", async () => {
    const run = fakeFilmRun();
    const writeSeen = vi.fn();
    // T-Q11 (#1151): this used to be byte-for-byte the desk test above, with
    // nothing pocket-related in it at all. beginFilm genuinely never
    // receives a viewport flag -- Tour.svelte reads isPocket() only inside
    // its own createFilmRun closure, threading it into createFilm() instead
    // (see Tour.svelte and film.js) -- which is exactly the mechanism that
    // lets a pocket viewport take this same path: createFilmRun decides
    // pocket-ness entirely on its own, so beginFilm must call it with
    // nothing. That is the one pocket-related fact this layer can check.
    const createFilmRun = vi.fn(() => run);
    const outcome = await beginFilm({
      readTour: async () => ({ tourSeenAt: null }),
      hasHousehold: () => true,
      createFilmRun,
      writeSeen,
    });

    expect(outcome).toBe("started");
    expect(createFilmRun).toHaveBeenCalledWith();
    expect(writeSeen).not.toHaveBeenCalled();

    /* The pocket cut spends `tourSeenAt` the same way the desk cut does:
       once, on end, never on start. */
    run.end();
    expect(writeSeen).toHaveBeenCalledTimes(1);
    run.end();
    expect(writeSeen).toHaveBeenCalledTimes(1);
  });
});

describe("beginFilm — tourSeenAt already set", () => {
  it("starts nothing", async () => {
    const createFilmRun = vi.fn(() => fakeFilmRun());
    const outcome = await beginFilm({
      readTour: async () => ({ tourSeenAt: "2026-09-01T00:00:00.000Z" }),
      hasHousehold: () => true,
      createFilmRun,
      writeSeen: () => {},
    });
    expect(outcome).toBe("already-seen");
    expect(createFilmRun).not.toHaveBeenCalled();
  });
});

describe("beginFilm — no household (the adrift sky, #864)", () => {
  it("starts nothing with tourSeenAt null", async () => {
    const createFilmRun = vi.fn(() => fakeFilmRun());
    const outcome = await beginFilm({
      readTour: async () => ({ tourSeenAt: null }),
      hasHousehold: () => false,
      createFilmRun,
      writeSeen: () => {},
    });
    expect(outcome).toBe("no-household");
    expect(createFilmRun).not.toHaveBeenCalled();
  });
});

describe("beginFilm — readTour throwing", () => {
  it("gives up quietly rather than interrupting the sky", async () => {
    const createFilmRun = vi.fn(() => fakeFilmRun());
    const outcome = await beginFilm({
      readTour: async () => { throw new Error("network"); },
      hasHousehold: () => true,
      createFilmRun,
      writeSeen: () => {},
    });
    expect(outcome).toBe("failed-read");
    expect(createFilmRun).not.toHaveBeenCalled();
  });
});

describe("beginFilm — skip writes tourSeenAt exactly once", () => {
  it("writes on the film's end (skip or finish), not on start, not twice", async () => {
    const run = fakeFilmRun();
    const writeSeen = vi.fn();
    const outcome = await beginFilm({
      readTour: async () => ({ tourSeenAt: null }),
      hasHousehold: () => true,
      createFilmRun: () => run,
      writeSeen,
    });
    expect(outcome).toBe("started");
    expect(writeSeen).not.toHaveBeenCalled();

    /* Skip (or Esc, or a natural finish) — player.js's `stop`/`finish`,
       both of which fire onEnd(true). */
    run.end();
    expect(writeSeen).toHaveBeenCalledTimes(1);

    /* Pressing Esc again after the film has already ended must not write a
       second time — the subscription is one-shot. */
    run.end();
    expect(writeSeen).toHaveBeenCalledTimes(1);
  });
});

/*
 * The wiring itself — source checks, in the style of
 * v19-tour-walk-again.test.mjs's own "the wiring" block. Proves Tour.svelte
 * actually calls trigger.js's beginFilm with the real phone check, the real
 * gates, and film.js — not just that beginFilm exists and passes in
 * isolation.
 */
describe("the wiring", () => {
  const tourSource = readFileSync(
    resolve(import.meta.dirname, "../../web/src/lib/tour/Tour.svelte"),
    "utf8",
  );

  it("Tour.svelte calls beginFilm, and hands the real film its pocket reading (#1083)", () => {
    expect(tourSource).toContain("beginFilm({");
    expect(tourSource).toContain("pocket: isPocket()");
  });

  it("Tour.svelte no longer draws the superseded card (§23)", () => {
    expect(tourSource).not.toContain("tourcard");
    expect(tourSource).not.toContain("./engine.js");
    expect(tourSource).not.toContain("./stops.js");
  });

  it("Tour.svelte builds the real film via createFilm", () => {
    expect(tourSource).toContain("createFilm({");
  });
});
