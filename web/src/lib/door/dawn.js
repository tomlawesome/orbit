/*
 * The two surfaces, mounted on the host's markup (markup.js): the dawn, and its first light; the dusk.
 *
 * mountDawn(host): the star fields and the glows on the dawn's markup. start(): its pictures asked for and its glows
 * drawn, once, after the next frame is on screen (so the sky is up before the work behind it starts). light(): first
 * light, below. live: the live door (door3d.js), where the host's flag asks for it. destroy(): the surface taken down
 * (a host that remounts its door): nothing of it listens any more.
 *
 * FIRST LIGHT. The ring is a light running its circle (body.loading) while the dawn's first pieces come (the type,
 * the Earth's first picture), a lap at a time, each lap ending in a breath; when they have come it finishes the lap
 * it is on and goes straight into its own drawing (body.lit), and the rest comes up after it. On a first visit it
 * always runs at least a lap, and keeps on (seven at most) until what the host waits for is ready too (`wait`: the
 * site's journeys, their shaders where compiles stall the page): the host readies them the moment the dawn's pieces
 * are in (`after`), so the laps, and then the reveal, and then the time spent taking the door in, are when they
 * come. On a later visit, with everything kept, it comes straight up. It never waits for ever: seven laps, or 13 s,
 * and the door lights regardless (and without the runner's motion, under reduced motion, on the pieces alone, up
 * to 8 s).
 *
 * THE CHORES (chores.js: the GPU's share of readying what the host has queued) begin the moment the reveal's
 * painted part has finished, on every browser: what only moves or fades is carried by the compositor, and nothing on
 * the page's thread can stutter it, but what is painted (the ring's stroke drawing in, the name's blur clearing,
 * anything inside an SVG) is drawn on the page's own thread, and a chore under it stutters it. So each such
 * animation is waited for, by its own end, not by a guess. Only the soft chores (a band of a picture put on the
 * GPU, under ~5 ms: upload.js) run during the reveal, one a frame, from the moment the door is lit (openSoft; not
 * with the holdreveal flag); and the reveal's longest gap between two frames is said with them when it ends (the
 * proof it stayed smooth: 16.7 ms is a whole frame at 60 Hz). Where compiles are in the background (`aside`), every
 * chore runs from the moment the door is lit, not from the reveal's end (chosen by eye on the laptop in Edge,
 * 8 October, against the held reveal and the two ring endings; the open=late flag holds them to the reveal's end,
 * to compare). Where a compile stalls the page (Firefox), held as before. To see, each at its own address: ring=stop,
 * the ring ends the moment the work is done and the drawn ring takes over from where the runner is; ring=rush, the
 * runner speeds up (x3) to finish its lap within about half a second.
 */
import { mountFlightSky, DAWN_FAR, DAWN_NEAR, DUSK_FAR, DUSK_NEAR } from "./stars.js";
import { mountRasters, SUN } from "./glows.js";
import { openSoft, openChores, softRan, note, holdReveal, compilesAside } from "./chores.js";
import { decodeAhead } from "./decode-ahead.js";
import { flag } from "./settings.js";

const afterFirstFrame = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
/* a wait that never holds anything for long: past the cap it goes with what it has */
const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

export function mountDawn(host) {
  const unsky = mountFlightSky(host.querySelector(".dsky"), DAWN_FAR, DAWN_NEAR, "lg");
  const world = host.querySelector(".world");
  const rasters = mountRasters(world, { sun: SUN }, "dawn");
  /* the Earth under the dawn: two pictures, asked for once the dawn is being drawn, each shown when it has come */
  const loadEarth = () => {
    for (const im of world.querySelectorAll(".earth image[data-href]")) {
      im.addEventListener("load", () => { im.classList.add("in"); if (im.classList.contains("pre")) world.classList.add("earthy"); }, { once: true });
      im.setAttribute("href", im.dataset.href); im.removeAttribute("data-href");
    }
  };
  let started = false, litOnce = false;
  const start = () => { if (started) return; started = true; afterFirstFrame(() => { loadEarth(); rasters.start(); }); };
  /* the pieces the door is made of, which would change its face as they arrived: the fonts, and the Earth's first picture */
  const critical = () => {
    const pre = world.querySelector(".earth image.pre");
    const earthHere = world.classList.contains("earthy") || !pre ? Promise.resolve()
      : new Promise((r) => { pre.addEventListener("load", r, { once: true }); pre.addEventListener("error", r, { once: true }); });
    return Promise.all([document.fonts?.ready, earthHere]);
  };
  /**
   * first light (above). firstVisit: at least a lap of the ring. wait: the ring runs on until what `after` returns
   * has resolved (the host caps it). after(): called once the ring is up and running (one frame shown), so a page
   * stopped by a compile stops behind it; the host readies what it has to and returns what the ring waits for (or
   * nothing). onLit(): body.lit is set, the reveal begins. onOpen(): the chores are open (openChores), the host may
   * start what waits for them (the live door's planets). aside: whether compiles here are in the background.
   */
  function light({ firstVisit = true, wait = false, after = () => null, onLit = () => {}, onOpen = () => {}, aside = compilesAside() } = {}) {
    const firstLight = !litOnce; litOnce = true;
    const crit = critical();
    const RING = flag("ring") || "", OPEN_EARLY = aside && flag("open") !== "late";
    let arrived = () => {};
    /* a first visit's first light is always at least a lap of the ring */
    const minLaps = wait || (firstLight && firstVisit) ? 1 : 0;
    let here = false;
    crit.then(() => {
      if (!wait) here = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const until = after();
        if (wait) Promise.resolve(until).catch(() => {}).then(() => { here = true; arrived(); });
      }));
    });
    let lit = false;
    const COMPOSITED = new Set(["transform", "opacity", "offset", "easing", "composite", "computedOffset"]);
    const painted = (a) => {
      try {
        const t = a.effect.target;
        if (t instanceof SVGElement && !(t instanceof SVGSVGElement)) return true;
        const props = a.transitionProperty ? [a.transitionProperty] : a.effect.getKeyframes().flatMap(Object.keys);
        return props.some((k) => !COMPOSITED.has(k));
      } catch { return true; }
    };
    const drawn = () => {
      try {
        const ends = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime) && painted(a));
        return Promise.all(ends.map((a) => a.finished.catch(() => {})));
      } catch { return Promise.resolve(); }
    };
    const go = () => { openChores(); onOpen(); };
    const lightNow = () => { if (lit) return; lit = true; requestAnimationFrame(() => { document.body.classList.remove("loading"); document.body.classList.add("lit");
      if (!holdReveal()) openSoft();
      let gap = 0, last = 0, timing = firstLight;
      const frame = (now) => { if (last) gap = Math.max(gap, now - last); last = now; if (timing) requestAnimationFrame(frame); };
      if (timing) requestAnimationFrame(frame);
      onLit();
      if (OPEN_EARLY) go();
      drawn().then(() => {
        if (timing) { timing = false; const s = softRan(); note(`reveal: ${s.n} soft chores ran, ${Math.round(s.ms)} ms; longest frame gap ${gap.toFixed(1)} ms${OPEN_EARLY ? " (the chores open with the reveal)" : " (held to the reveal's end)"}`); }
        if (!OPEN_EARLY) go();
      }); }); };
    within(crit, 250).then(() => {
      if (here && !minLaps) { lightNow(); return; }
      document.body.classList.add("loading");
      const ring = host.querySelector(".lockup .runner");
      let laps = 0;
      const lap = () => {
        laps++;
        const enough = here && laps >= minLaps;
        if (enough || laps >= 7) { ring?.removeEventListener("animationiteration", lap); lightNow(); }
      };
      ring?.addEventListener("animationiteration", lap);
      /* ring=stop: lit the moment the work is done; ring=rush: the runner's lap finished at three times its pace */
      arrived = () => {
        if (lit || !ring) return;
        if (RING === "stop") { ring.removeEventListener("animationiteration", lap); note("ring: stopped where it was"); lightNow(); }
        else if (RING === "rush") { try { ring.getAnimations().forEach((a) => { a.playbackRate = 3; }); note("ring: rushed to the lap's end"); } catch { /* the lap as it is */ } }
      };
      if (here) arrived();
      /* without the animation (reduced motion), just the pieces */
      if (!ring || getComputedStyle(ring).animationName === "none") within(crit, 8000).then(lightNow);
      setTimeout(lightNow, 13000);
    });
  }
  /* the live door (door3d.js), fetched only where the host's flag asks for it: its compiles, its start, and when it
     has been measured and shown (the host's own planets start only after that, so the door's measure is its own) */
  const door3d = flag("door3d") ? import("./door3d.js") : null;
  const live = door3d ? {
    compile: () => door3d.then((m) => m.compileDoor()),
    start: () => door3d.then((m) => m.liveDoor(world)),
    measured: door3d.then((m) => m.doorMeasured, () => null),
    firstCompiled: () => door3d.then((m) => m.doorFirstCompiled()),
  } : null;
  const destroy = () => { unsky(); rasters.stop(); };
  return { host, world, start, light, live, destroy };
}

/* the dusk: its star field, its glows' origin, and its pictures decoded ahead of the beat that shows them */
export function mountDusk(host) {
  const unsky = mountFlightSky(host.querySelector(".dsky"), DUSK_FAR, DUSK_NEAR, "dk");
  const world = host.querySelector(".world");
  const rasters = mountRasters(world, {}, "dusk");
  let started = false, held = null;
  const start = () => {
    if (started) return; started = true;
    held = decodeAhead([...world.querySelectorAll("image[href]")].map((im) => im.getAttribute("href")));
    afterFirstFrame(rasters.start);
  };
  const destroy = () => { unsky(); rasters.stop(); held = null; };
  return { host, world, start, destroy, get held() { return held; } };
}
