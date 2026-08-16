/**
 * THE SEQUENCES — the wall clock of the ratified flight (#410, §15).
 *
 * Every number here is design/v19/first-run.html's own, as committed at
 * 159ec9f. The mockup wrote them as a wall of `after(ms, fn)` calls; they are
 * data here so the same list can be run live (setTimeout) or PINNED (every
 * beat up to a given millisecond applied at once), which is what makes a
 * moving thing screenshottable and unit-testable. The beats and their order
 * are not adapted — only the way they are dispatched.
 *
 *   ASCENT · wall clock from the call
 *      0     arming; the mark's centre goes white
 *      200   the canvas takes over and the flight starts
 *      260   the mark leaves the lockup and rides to centre screen (1.08s)
 *      430   the login is released
 *     1340   the mark puts itself out
 *     1560   the household's name is written on the void
 *     2600   and taken away again
 *     4800   handoff INSIDE the light — the canvas dissolves over 1.7s while
 *            the bodies condense out of it over 1.3s
 *     6400   the bare sky is readable: planets, sun, the household's name
 *     8400   two seconds later the instrument arrives (1.7s, arrive style) —
 *            the dwell trimmed and the draw-in slowed by the owner's
 *            2026-08-16 amendment; see T below
 *
 *   DESCENT · the ascent mirrored, in the DOM as well as on the canvas
 *      0     the instrument withdraws (arrive, reversed)
 *      620   the bodies disperse
 *      700   the canvas takes over and the reversed flight begins
 *     1000   the home surface is released
 *     2580   the household's name on the void, "signing out" beneath it
 *     3467   and taken away again
 *     3600   the dusk surface comes up under the cooling dawn
 *     3655   the mark reappears at centre and rides down to the lockup
 *     4150   the flight is over and the canvas is released
 *     5100   the mark hands back to the lockup's own glyph
 *     5350   the farewell speaks
 */

/*
 * THE ONE AMENDMENT TO THE RATIFIED SHEET (owner, 2026-08-16, ledger 7f7d813):
 * "the dwell on the bare sky before the instrument arrives is 1s too long
 *  (3s → 2s), and the dial's pop is slightly too fast — slow its draw-in a
 *  touch. The stated test: it must feel like a DELIBERATE WAIT, not a slow
 *  load. Otherwise perfect."
 *
 * So `dwell` is 2000 and `instrument` stretches 1300 → 1700; the CURVE is
 * untouched, because the ruling is about pace, not shape, and duration is the
 * smallest change that answers it. Everything else on the clock stays
 * verbatim. first-run v5 carries these numbers in the mockup — when it lands,
 * re-read them from it: if v5 chose different figures, v5 wins and this table
 * follows it.
 */
export const T = {
  warp: 200, mark: 260, release: 430, markOut: 1340,
  nameOn: 1560, nameOff: 2600,
  land: 4800, condensed: 6400, dwell: 2000, instrument: 1700,
  tourGap: 450,
};
T.instrumentAt = T.condensed + T.dwell;                    /*  8400 */
T.tourAt = T.instrumentAt + T.instrument + T.tourGap;      /* 10550 */

/* the descent's own offsets, kept as the mockup wrote them: the flight starts
   700ms in, and the mirrored windows are quoted against that. */
export const D = {
  withdraw: 0, disperse: 620, warp: 700, release: 1000,
  nameOn: 700 + 1880, nameOff: 700 + 2767, markIn: 700 + 2955,
  dusk: 3600, warpOut: 4150, markHome: 5100, farewell: 5350,
};
/* the mark rides 260 → 1340 out of the lockup on the climb, so on the way
   down it rides the mirrored window: 923ms. */
export const MARK_RIDE_UP = 1080;
export const MARK_RIDE_DOWN = 923;

const byTime = (a, b) => a.at - b.at;

/** The launch, as beats. */
export function ascentBeats() {
  return [
    { at: 0, act: "arming" },
    { at: T.warp, act: "warp" },
    { at: T.mark, act: "mark" },
    { at: T.release, act: "release" },
    { at: T.markOut, act: "markOut" },
    { at: T.nameOn, act: "nameOn" },
    { at: T.nameOff, act: "nameOff" },
    { at: T.land, act: "land" },
    { at: T.instrumentAt, act: "instrument" },
  ].sort(byTime);
}

/** The descent, as beats. */
export function descentBeats() {
  return [
    { at: D.withdraw, act: "withdraw" },
    { at: D.disperse, act: "disperse" },
    { at: D.warp, act: "warp" },
    { at: D.release, act: "release" },
    { at: D.nameOn, act: "nameOn" },
    { at: D.nameOff, act: "nameOff" },
    { at: D.dusk, act: "dusk" },
    { at: D.markIn, act: "markIn" },
    { at: D.warpOut, act: "warpOut" },
    { at: D.markHome, act: "markHome" },
    { at: D.farewell, act: "farewell" },
  ].sort(byTime);
}

/**
 * Reduced motion (the mockup's own rule, and law here): the launch is the one
 * thing on this sheet that cannot be slowed down, so it is NOT played. The
 * flight becomes a plain crossfade over ~0.7s — and the STAGING SURVIVES
 * INTACT, because the staging is class-driven and not motion-driven: the bare
 * sky still lands bare, the dwell still passes, the instrument still arrives
 * after it.
 */
export function ascentBeatsReduced() {
  return [
    { at: 0, act: "land" },
    { at: 700 + T.dwell, act: "instrument" },
  ];
}
export function descentBeatsReduced() {
  /* `disperse` is doing what the mockup's `remove("showhome")` does: taking
     the landing off the screen. Without it the dusk arrives ON TOP of a home
     that is still sitting there, which is not a quieter version of the
     descent — it is a broken one. The stylesheet drops its transition under
     reduced motion, so the surface simply changes. */
  return [
    { at: 0, act: "withdraw" },
    { at: 0, act: "disperse" },
    { at: 0, act: "dusk" },
    { at: 0, act: "farewell" },
  ];
}

/**
 * Run a beat list.
 *
 * Live, each beat is a timer and the returned function cancels what is still
 * pending. Pinned (`at` a number), every beat at or before that millisecond is
 * applied immediately, in order, and nothing is scheduled — the surface then
 * stands still at exactly that moment of the flight.
 */
export function runTimeline(beats, apply, { at, schedule, cancel } = {}) {
  if (typeof at === "number") {
    for (const beat of beats) if (beat.at <= at) apply(beat.act, beat);
    return () => {};
  }
  const setTimer = schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = cancel ?? ((id) => clearTimeout(id));
  const timers = beats.map((beat) => setTimer(() => apply(beat.act, beat), beat.at));
  return () => timers.forEach(clearTimer);
}
