/*
 * THE JOURNEY (Orbit's Flight.svelte, without the framework): the canvas between the dawn and the sky, and the name
 * written once on the void; the door's ring stays in the door and goes as it goes. The surfaces are the host's; this
 * only says WHEN, in the body-class vocabulary the stylesheet answers (door.css), and calls the host's hooks at the
 * named points. The flights themselves (the profiles) are the host's too: the climb and the descent are here (UP,
 * DOWN, DOWN_DAWN), and a host makes its own from them (the site: assets/js/journeys.js).
 */
import { createFlight, UP, DOWN, UPDUR, DOWNDUR, REV, SWEEP, DEEP_SKIP, homeProps } from "./engine.js";
import { drawnIn } from "./chores.js";
import { ascentBeats, ascentBeatsReduced, descentBeats, descentBeatsReduced, runTimeline, D } from "./timeline.js";

/* the descent that sets down on the dawn again, rather than cooling into the dusk */
export const DOWN_DAWN = { ...DOWN, palTo: undefined, duskMix: undefined };
/* the descent from a landing: that landing's own climb run backwards — its
   vanishing point, its bearings, its traffic met the other way, and its own
   ending undone first, so a ring leaves as a ring and a sweep as a sweep */
export const mirrored = (props) => props.map((g) => ({ ...g, spin: -(g.spin || 0), dur: g.dur * REV * SWEEP, t0: Math.max(0, (UPDUR - (g.t0 + g.dur)) * REV) }));
/* out of the docs' galaxy it starts past its still first part (engine.js: DEEP_SKIP) */
const DEEP_SKIP_T = (DOWNDUR * DEEP_SKIP) / UPDUR;
export const descentFrom = (P) => ({ ...DOWN_DAWN, rate: P.rate ? DOWNDUR / (DOWNDUR - 1000) : undefined, vpX: P.vpX, vpY: P.vpY, a0: P.a0, a1: P.a1, ending: P.ending, chart: P.chart, tint: P.tint, props: mirrored(P.props),
  ...(P.ending === "chart" ? { skip: DEEP_SKIP_T, skipTu: DEEP_SKIP } : {}) });

/* the profile descend() starts the engine with (pure, so a test in Node can read it). Without `homes` it is the descent
   the site has always flown: DOWN itself, DOWN_DAWN itself, or the climb `from` run backwards. With homes (the other
   households met again on the way down, Orbit's #26) their props, mirrored, are added on the end of the base's, so
   whatever the base is, it is never changed. With `from`, the climb's own homes are already mirrored in: a host gives
   `homes` as well only if the climb did not carry them */
export function descentProfile({ onto = "dusk", from = null, homes = [] } = {}) {
  const base = from ? descentFrom(from) : onto === "dawn" ? DOWN_DAWN : DOWN;
  return homes && homes.length ? { ...base, props: [...base.props, ...mirrored(homeProps(homes))] } : base;
}

const CLASSES = ["arming", "showdawn", "showwarp", "launching", "bare", "instrument", "withdrawing", "dispersing", "showdusk", "farewell"];

/* a flight played faster keeps every beat in step: those inside it scale with it, those after it come sooner by what it saved */
const quicken = (beats, dur, rate) => (rate === 1 ? beats : beats.map((b) => ({ ...b, at: b.at <= dur ? b.at / rate : b.at - (dur - dur / rate) })));

/* the journey's clock: real time, except that a stall (the page busy for a moment: a picture decoded, a shader made
   ready) is counted as no more than a frame or so while the climb's WebGL world is drawing (stalls: Orbit's #1262),
   so a stall pauses the journey where it is rather than skipping it ahead to the landing; otherwise real time, so a
   machine that simply draws slowly finishes the journey on time rather than stretching it. The flight and its beats
   both keep this time. The descent always keeps real time */
/* how long the climb's hold waits for the flight's world before going on without it (holdAt) */
const WORLD_WAIT = 8000;
function journeyClock() {
  let t = 0, last = performance.now(), raf = 0, hold = null, cap = Infinity;
  const pending = new Map(); let ids = 0;
  /* a hold: the clock stops at a point in the journey until something it needs has come (the host gives it what the
     flight draws), so a journey can start the moment it is chosen and still never draw before it is ready. It lets
     go by itself once the clock has stood at it for WORLD_WAIT of real time, counted from when the journey reaches
     it, not from when it was set (Orbit's #1299) */
  const now = () => {
    const p = performance.now(); t += Math.min(cap, Math.max(0, p - last)); last = p;
    if (hold && !hold.done && t > hold.at) {
      if (hold.since === null) hold.since = p;
      if (p - hold.since >= WORLD_WAIT) hold.done = true; else t = hold.at;
    }
    return t;
  };
  const poll = () => {
    raf = 0; const at = now();
    for (const [id, b] of pending) if (b.at <= at) { pending.delete(id); b.fn(); }
    if (pending.size) raf = requestAnimationFrame(poll);
  };
  return {
    now,
    /** count a stall as a frame or so (true), or keep real time (false) */
    stalls(on) { now(); cap = on ? 64 : Infinity; },
    schedule(fn, ms) { const id = ++ids; pending.set(id, { at: now() + ms, fn }); if (!raf) raf = requestAnimationFrame(poll); return id; },
    holdAt(ms, until) { const h = { at: now() + ms, done: false, since: null }; hold = h; const free = () => { h.done = true; }; until.then(free, free); return h; },
    cancel(id) { pending.delete(id); },
    /** the hold let go: a journey that starts after one still pending is not clamped at it */
    release() { hold = null; },
    /** everything still pending dropped (the journey is going) */
    dispose() { pending.clear(); if (raf) cancelAnimationFrame(raf); raf = 0; hold = null; },
  };
}

/* where in a pinned flight's own time the journey's `at` falls: the flight began at its warp beat (in the journey's own,
   already transformed, time), runs at its profile's rate, and may start a little way into itself (P.skip); a live
   flight is left to its clock (the empty options) */
const pinnedFlight = (P, at, warpAt) => (typeof at === "number"
  ? { at: Math.min(Math.max(0, (at - warpAt) * (P.rate || 1) + (P.skip || 0)), P.dur ?? Infinity) } : {});
/* a pin at or after the beat that takes the canvas off the screen: there is nothing of the flight to see, and stepping
   it frame by frame to draw it (slow where the GPU is software) would only hold up every beat after it */
const gone = (beats, at, act) => typeof at === "number" && beats.some((b) => b.act === act && b.at <= at);

export function createJourney({ canvas, name, dawnGlyph, duskGlyph, on = {} }) {
  const clock = journeyClock();
  const engine = createFlight(canvas, { now: clock.now });
  const onResize = () => engine.resize();
  addEventListener("resize", onResize);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const body = document.body;
  let cancelTimeline = () => {};
  /* the host's leisure work still waiting (later), each by its own stop; a flight or a descent beginning drops them all */
  const leisure = new Set();
  const dropLeisure = () => { for (const stop of [...leisure]) stop(); };
  /**
   * `fn` at leisure: after `after` ms, and once the page's painted animations have finished (chores.js: drawnIn), so
   * work that touches the GPU never runs under a reveal still being drawn. Dropped, never called, if a flight or a
   * descent begins first (a compile on the page's own thread, started mid-flight, is a pause of over a second in the
   * middle of it: Orbit's #1299), or by the stop it returns.
   * @param {() => void} fn @param {{ after?: number }} [how] @returns {() => void}
   */
  function later(fn, { after = 4000 } = {}) {
    let off = false, timer = 0;
    const stop = () => { off = true; clearTimeout(timer); leisure.delete(stop); };
    timer = setTimeout(() => { drawnIn().then(() => { if (!off) { leisure.delete(stop); fn(); } }); }, after);
    leisure.add(stop);
    return stop;
  }

  let flight = { profile: UP, on: {} };
  const ascentStep = (act, beat) => {
    switch (act) {
      case "arming": body.classList.add("arming"); break;
      case "warp": body.classList.add("showwarp"); if (flight.gone) { engine.clear(); clock.stalls(false); } else { engine.start(flight.profile, pinnedFlight(flight.profile, flight.at, beat.at)); clock.stalls(engine.drawingWorld); } break;
      /* the door's ring is not lifted out of it: it goes as the door goes, as on the install's and the information's shots */
      case "mark": body.classList.remove("arming"); break;
      case "release": body.classList.remove("showdawn"); (flight.on.release ?? on.release)?.(); break;
      case "nameOn": name.classList.add("on"); break;
      case "nameOff": name.classList.remove("on"); break;
      case "land": body.classList.remove("showwarp", "launching"); body.classList.add("bare"); (flight.on.land ?? on.land)?.(); break;
      case "instrument": body.classList.remove("bare"); body.classList.add("instrument"); (flight.on.settled ?? on.settled)?.(); break;
    }
  };
  let descent = { onto: "dusk", from: null, homes: [], on: {} };
  const descentStep = (act, beat) => {
    switch (act) {
      case "withdraw": body.classList.remove("instrument"); body.classList.add("withdrawing"); break;
      case "disperse": body.classList.add("dispersing"); break;
      case "warp": {
        const P = descentProfile(descent);
        body.classList.add("showwarp"); if (descent.gone) { engine.clear(); clock.stalls(false); } else engine.start(P, pinnedFlight(P, descent.at, beat.at)); break;
      }
      case "release": body.classList.remove("withdrawing"); (descent.on.released ?? on.released)?.(); break;
      case "nameOn": name.classList.add("on"); break;
      case "nameOff": name.classList.remove("on"); break;
      case "dusk": body.classList.add(descent.onto === "dawn" ? "showdawn" : "showdusk"); (descent.on.surface ?? on.dusk)?.(); break;
      case "warpOut": body.classList.remove("showwarp"); break;
      case "farewell": body.classList.add("farewell"); (descent.on.farewell ?? on.farewell)?.(); break;
    }
  };
  function reset() {
    cancelTimeline(); cancelTimeline = () => {};
    engine.clear(); clock.stalls(false); clock.release();
    body.classList.remove(...CLASSES);
    name.classList.remove("on");
    for (const el of [dawnGlyph(), duskGlyph()]) if (el) el.style.visibility = "";
  }
  const write = (title, subtitle) => name.replaceChildren(document.createTextNode(title), Object.assign(document.createElement("i"), { textContent: subtitle }));
  /* fly: any profile, to whichever landing `on` describes. `at` (ms into the journey, in its own time) pins it there:
     the beats up to `at` are applied at once, the flight drawn as it stands then, and nothing after is scheduled */
  function fly(profile, { title = "", subtitle = "", on: hooks = {}, ready = null, at } = {}) {
    dropLeisure();
    cancelTimeline(); clock.release();
    body.classList.remove(...CLASSES, "holding");
    const pinned = typeof at === "number";
    flight = { profile, on: hooks, at, gone: false };
    write(title, subtitle);
    body.classList.add("showdawn", "launching");
    let beats = reduced ? ascentBeatsReduced() : quicken(ascentBeats(), UPDUR, profile.rate || 1);
    /* not yet ready: the journey still starts at once, and the clock holds just before the flight's canvas comes up
       until what it draws is ready */
    if (ready && !reduced && !pinned) {
      const warp = beats.find((b) => b.act === "warp")?.at ?? 0;
      body.classList.add("holding");
      clock.holdAt(Math.max(0, warp - 10), ready.finally(() => body.classList.remove("holding")));
    }
    flight.gone = gone(beats, at, "land");
    cancelTimeline = runTimeline(beats, ascentStep, pinned ? { at } : clock);
  }
  const ascend = (o = {}) => fly(UP, o);
  /* `at` as for fly(): ms into the descent's own (quickened) time */
  function descend({ title = "", subtitle = "signing out", onto = "dusk", from = null, homes = [], on: hooks = {}, at } = {}) {
    dropLeisure();
    cancelTimeline();
    /* the climb's warp left the stall cap on, and may have left its hold: the descent keeps real time, or a slowly
       drawn world stretches it out of reach, and never waits for a world the climb was waiting for */
    clock.stalls(false); clock.release();
    body.classList.remove("showdawn", "showdusk", "farewell", "bare", "launching");
    descent = { onto, from, homes, on: hooks, at, rate: from?.rate ? DOWNDUR / (DOWNDUR - 1000) : 1 };
    write(title, subtitle);
    let beats = descentBeats();
    /* out of the docs' galaxy: under way at once. The page lets go as the flight comes up beneath it (the same sky,
       so the one becomes the other), and the flight starts past its still first part, the camera already drawing
       back; everything after comes sooner by as much */
    if (from?.ending === "chart") {
      const warp = 300, shift = D.warp - warp + DEEP_SKIP_T;
      beats = beats.map((b) => (b.act === "withdraw" ? b : b.act === "disperse" ? { ...b, at: 240 } : b.act === "warp" ? { ...b, at: warp } : { ...b, at: Math.max(warp + 60, b.at - shift) }));
    }
    beats = reduced ? descentBeatsReduced() : quicken(beats, DOWNDUR, descent.rate);
    descent.gone = gone(beats, at, "warpOut");
    /* (a descent never waits for the flight's world: at the warp it draws it if its verdict is in and fit, else it is painted) */
    cancelTimeline = runTimeline(beats, descentStep, typeof at === "number" ? { at } : clock);
  }
  /* the journey taken down (a host that remounts its door): nothing of it keeps running or listening */
  function destroy() { dropLeisure(); reset(); engine.destroy(); clock.dispose(); removeEventListener("resize", onResize); }
  return { fly, ascend, descend, reset, destroy, later, reduced, warm: (how) => engine.warm(how), warmDocs: (how) => engine.warmDocs(how), compiled: () => engine.compiled() };
}
