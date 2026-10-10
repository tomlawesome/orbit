/*
 * THE JOURNEY (Orbit's Flight.svelte, without the framework): the canvas between the dawn and the sky, and the name
 * written once on the void; the door's ring stays in the door and goes as it goes. The surfaces are the host's; this
 * only says WHEN, in the body-class vocabulary the stylesheet answers (door.css), and calls the host's hooks at the
 * named points. The flights themselves (the profiles) are the host's too: the climb and the descent are here (UP,
 * DOWN, DOWN_DAWN), and a host makes its own from them (the site: assets/js/journeys.js).
 */
import { createFlight, UP, DOWN, UPDUR, DOWNDUR, REV, SWEEP, DEEP_SKIP } from "./engine.js";
import { ascentBeats, ascentBeatsReduced, descentBeats, descentBeatsReduced, runTimeline, D } from "./timeline.js";

/* the descent that sets down on the dawn again, rather than cooling into the dusk */
export const DOWN_DAWN = { ...DOWN, palTo: undefined, duskMix: undefined };
/* the descent from a landing: that landing's own climb run backwards — its
   vanishing point, its bearings, its traffic met the other way, and its own
   ending undone first, so a ring leaves as a ring and a sweep as a sweep */
const mirrored = (props) => props.map((g) => ({ ...g, spin: -(g.spin || 0), dur: g.dur * REV * SWEEP, t0: Math.max(0, (UPDUR - (g.t0 + g.dur)) * REV) }));
/* out of the docs' galaxy it starts past its still first part (engine.js: DEEP_SKIP) */
const DEEP_SKIP_T = (DOWNDUR * DEEP_SKIP) / UPDUR;
export const descentFrom = (P) => ({ ...DOWN_DAWN, rate: P.rate ? DOWNDUR / (DOWNDUR - 1000) : undefined, vpX: P.vpX, vpY: P.vpY, a0: P.a0, a1: P.a1, ending: P.ending, chart: P.chart, tint: P.tint, props: mirrored(P.props),
  ...(P.ending === "chart" ? { skip: DEEP_SKIP_T, skipTu: DEEP_SKIP } : {}) });

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

export function createJourney({ canvas, name, dawnGlyph, duskGlyph, on = {} }) {
  const clock = journeyClock();
  const engine = createFlight(canvas, { now: clock.now });
  const onResize = () => engine.resize();
  addEventListener("resize", onResize);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const body = document.body;
  let cancelTimeline = () => {};

  let flight = { profile: UP, on: {} };
  const ascentStep = (act) => {
    switch (act) {
      case "arming": body.classList.add("arming"); break;
      case "warp": body.classList.add("showwarp"); engine.start(flight.profile); clock.stalls(engine.drawingWorld); break;
      /* the door's ring is not lifted out of it: it goes as the door goes, as on the install's and the information's shots */
      case "mark": body.classList.remove("arming"); break;
      case "release": body.classList.remove("showdawn"); (flight.on.release ?? on.release)?.(); break;
      case "nameOn": name.classList.add("on"); break;
      case "nameOff": name.classList.remove("on"); break;
      case "land": body.classList.remove("showwarp", "launching"); body.classList.add("bare"); (flight.on.land ?? on.land)?.(); break;
      case "instrument": body.classList.remove("bare"); body.classList.add("instrument"); (flight.on.settled ?? on.settled)?.(); break;
    }
  };
  let descent = { onto: "dusk", from: null, on: {} };
  const descentStep = (act) => {
    switch (act) {
      case "withdraw": body.classList.remove("instrument"); body.classList.add("withdrawing"); break;
      case "disperse": body.classList.add("dispersing"); break;
      case "warp": body.classList.add("showwarp"); engine.start(descent.from ? descentFrom(descent.from) : descent.onto === "dawn" ? DOWN_DAWN : DOWN); break;
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
  /* fly: any profile, to whichever landing `on` describes */
  function fly(profile, { title = "", subtitle = "", on: hooks = {}, ready = null } = {}) {
    cancelTimeline(); clock.release();
    body.classList.remove(...CLASSES, "holding");
    flight = { profile, on: hooks };
    write(title, subtitle);
    body.classList.add("showdawn", "launching");
    let beats = reduced ? ascentBeatsReduced() : quicken(ascentBeats(), UPDUR, profile.rate || 1);
    /* not yet ready: the journey still starts at once, and the clock holds just before the flight's canvas comes up
       until what it draws is ready */
    if (ready && !reduced) {
      const warp = beats.find((b) => b.act === "warp")?.at ?? 0;
      body.classList.add("holding");
      clock.holdAt(Math.max(0, warp - 10), ready.finally(() => body.classList.remove("holding")));
    }
    cancelTimeline = runTimeline(beats, ascentStep, clock);
  }
  const ascend = (o = {}) => fly(UP, o);
  function descend({ title = "", subtitle = "signing out", onto = "dusk", from = null, on: hooks = {} } = {}) {
    cancelTimeline();
    /* the climb's warp left the stall cap on, and may have left its hold: the descent keeps real time, or a slowly
       drawn world stretches it out of reach, and never waits for a world the climb was waiting for */
    clock.stalls(false); clock.release();
    body.classList.remove("showdawn", "showdusk", "farewell", "bare", "launching");
    descent = { onto, from, on: hooks, rate: from?.rate ? DOWNDUR / (DOWNDUR - 1000) : 1 };
    write(title, subtitle);
    let beats = descentBeats();
    /* out of the docs' galaxy: under way at once. The page lets go as the flight comes up beneath it (the same sky,
       so the one becomes the other), and the flight starts past its still first part, the camera already drawing
       back; everything after comes sooner by as much */
    if (from?.ending === "chart") {
      const warp = 300, shift = D.warp - warp + DEEP_SKIP_T;
      beats = beats.map((b) => (b.act === "withdraw" ? b : b.act === "disperse" ? { ...b, at: 240 } : b.act === "warp" ? { ...b, at: warp } : { ...b, at: Math.max(warp + 60, b.at - shift) }));
    }
    cancelTimeline = runTimeline(reduced ? descentBeatsReduced() : quicken(beats, DOWNDUR, descent.rate), descentStep, clock);
  }
  /* the journey taken down (a host that remounts its door): nothing of it keeps running or listening */
  function destroy() { reset(); clock.dispose(); removeEventListener("resize", onResize); }
  return { fly, ascend, descend, reset, destroy, reduced, warm: () => engine.warm(), warmDocs: () => engine.warmDocs(), compiled: () => engine.compiled() };
}
