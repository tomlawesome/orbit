<script>
  import { onMount } from "svelte";
  import { createFlight, UP, DOWN, PROPS_UP, PROPS_DOWN, homeProps, mirrored } from "./engine.js";
  import {
    ascentBeats, ascentBeatsReduced, descentBeats, descentBeatsReduced,
    newcomerAscentBeats, newcomerAscentBeatsReduced,
    runTimeline, MARK_ARRIVE, MARK_RIDE_UP, MARK_RIDE_DOWN, D,
  } from "./timeline.js";
  import { journeyClock, WORLD_WAIT } from "./journey-clock.js";
  import { readyFlight } from "./warm.js";
  import "./flight.css";

  /**
   * THE FLIGHT, as a surface (#410, §15).
   *
   * Owns the three things the flight draws over everything else: the canvas,
   * the mark that leaves the lockup and rides to the centre of the screen, and
   * the household's name written once on the void. The dawn and the dusk are
   * the host's (they are also screens in their own right), and the landing is
   * the host's too — this component only says WHEN, in the body-class
   * vocabulary the mockup uses, and the host's stylesheet answers.
   *
   * THE ONE HONEST DEVIATION — see also the note on the sign-in gate.
   * The mockup plays ignition → climb → reveal → landing unbroken from the
   * press of the button. The product cannot: the press leaves Orbit for the
   * identity provider, and the browser returns on a new document. So the
   * journey is cut at the only place reality cuts it — the departure — and
   * NOT ONE MILLISECOND OF THE FLIGHT IS CHANGED. The gate's flash plays on
   * the way out (the mockup's own 420 → 900 window) and the launch itself,
   * all 4.8 seconds of it plus the bare-sky dwell and the instrument's
   * arrival, plays whole on the authenticated return, before home settles.
   */
  let {
    /* the household's name, written on the void at the top of the climb */
    name = "",
    /* what the void says underneath it */
    subtitle = "welcome back",
    /*
     * WHERE THE CLIMB SETS DOWN (§15 second pass, ruling 4): "home" is the
     * landing every member gets, and "newcomer" is the one a reader who
     * belongs to nothing yet gets — the same flight to the millisecond, the
     * ratified 3s dwell instead of the trimmed 2s, and the count's own three
     * beats after it. The host draws both; this only says when.
     *
     * "invited" (#871) flies the identical newcomer beats — the host's own
     * INVITED stage feeds `Newcomer.svelte` the same sky and count a plain
     * newcomer gets — and differs at exactly one beat: see `onbelong` below.
     */
    landing = "home",
    /* the landing: the host reveals its own surface here (bare sky) */
    onland = () => {},
    /* the instrument has arrived and the journey is over */
    onsettled = () => {},
    /*
     * WHERE THE CHOOSER WOULD STAND (#871). On landing "newcomer" this beat is
     * drawn — `belong` arrives as a body class and the host's own markup shows
     * or hides behind it. On landing "invited" there is no chooser to show at
     * any frame, drawn or hidden, so the class is never added and this fires
     * instead: the host's one hook to move on to the household the invitation
     * named, by the same road landing "home" already takes there (a launch
     * marker and a navigation) — this component draws no second camera move.
     */
    onbelong = () => {},
    /* the descent has finished: the reader is on the dusk */
    onfarewell = () => {},
    /*
     * THE OTHER HOUSEHOLDS (#1253 ruling 3): the reader's real other
     * households, passed on the climb and met again on the descent, as
     * engine.js `othersOf` reads them from the galaxy. Body tones may be CSS
     * custom property names; they are read as colours when the flight starts.
     * Empty for a reader with one household: nothing made up passes instead.
     * Each is { name, bodies: [[x, y, tone, r]] }.
     */
    homes = [],
  } = $props();

  /** @type {HTMLCanvasElement} */
  let canvas;
  /** @type {HTMLDivElement} */
  let markEl;
  /** @type {HTMLDivElement} */
  let nameEl;
  /** @type {ReturnType<typeof createFlight> | null} */
  let engine = null;
  /** The current engine, cast for the call sites that only ever run once the
      component has mounted and `engine` has been set. */
  function activeEngine() {
    return /** @type {ReturnType<typeof createFlight>} */ (engine);
  }
  let cancelTimeline = () => {};
  /* what the void says under the household's name: the ascent's own word on
     the way up, "signing out" on the way down. Set when a journey starts, so
     it never reads back the other direction's line. */
  let subtitleText = $state("");

  const body = () => document.body;
  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* #1253: the journey keeps its own time (journey-clock.js), so a stall
     while the flight's world is readied pauses the journey rather than
     skipping it ahead; the engine and the live beats both read it */
  const clock = journeyClock();

  onMount(() => {
    const flightEngine = createFlight(canvas, { now: clock.now });
    engine = flightEngine;
    const onResize = () => flightEngine.resize();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      cancelTimeline();
      clock.dispose();
      flightEngine.clear();
      flightEngine.release();
      reset();
    };
  });

  /* the mark leaves the lockup and rides to the centre of the screen — and the
     dial's sun, 2s later, blooms out of exactly that point. `size` is where it
     ARRIVES, not a multiplier: the lockup's ring is the 420px hero now, so the
     ride contracts rather than grows (see MARK_ARRIVE).

     THE RIDE ITSELF IS `transform`, NOT `left`/`top`/`width`/`height` (#873).
     The element is set to its RESTING geometry once, with no transition — the
     motion is a FLIP overlay (see `flip()` below): a `translate()+scale()`
     that stands the mark visually at the source rect, played off via the Web
     Animations API back to identity. Same start point, same end point, same
     curve as the box-geometry transition this replaces; the only thing that
     changed is that the compositor can now play it without asking the main
     thread to lay out or paint again on every frame — which matters because
     the canvas engine's own rAF loop (`engine.js`) is already spending the
     frame on the star field for the whole length of this ride. Using the Web
     Animations API rather than a second CSS transition also means nothing is
     left on `markEl.style.transition` that could shadow `dropMark()`'s own
     `.collapse` rule (flight.css) the way a lingering `transition` shorthand
     would; the `.4s ease` opacity fallback below is exactly what the old
     left/top/width/height transition also left behind for it. */
  /**
   * @param {SVGElement | null} srcSvg
   * @param {number} toY
   * @param {number} size
   * @param {number} ms
   * @param {boolean} instant
   */
  function liftMark(srcSvg, toY, size, ms, instant) {
    if (!srcSvg) return;
    const r = srcSvg.getBoundingClientRect();
    const left = innerWidth / 2 - size / 2, top = toY - size / 2;
    markEl.style.transition = "none";
    markEl.style.left = r.left + "px"; markEl.style.top = r.top + "px";
    markEl.style.width = r.width + "px"; markEl.style.height = r.height + "px";
    markEl.classList.remove("collapse");
    markEl.classList.add("on");
    srcSvg.style.visibility = "hidden";
    /* the box stands at rest here — where it ARRIVES — from this point on;
       only the visual overlay (instant: none, live: the FLIP below) differs */
    markEl.style.left = left + "px"; markEl.style.top = top + "px";
    markEl.style.width = size + "px"; markEl.style.height = size + "px";
    if (!instant) flip(r, left, top, size, size, ms);
  }
  /**
   * THE FLIP (#873). `markEl` already stands at its resting geometry
   * (`toLeft`/`toTop`/`toWidth`/`toHeight`, set by the caller just above) —
   * this pins it visually to `from` with one `transform`, then plays that
   * transform back to identity over `ms` on its own Web Animation, which
   * composites independently of `style.transition`/`style.transform` and
   * leaves neither set once it is done.
   * @param {{ left: number, top: number, width: number, height: number }} from
   * @param {number} toLeft @param {number} toTop
   * @param {number} toWidth @param {number} toHeight
   * @param {number} ms
   */
  function flip(from, toLeft, toTop, toWidth, toHeight, ms) {
    const dx = (from.left + from.width / 2) - (toLeft + toWidth / 2);
    const dy = (from.top + from.height / 2) - (toTop + toHeight / 2);
    const sx = from.width / toWidth, sy = from.height / toHeight;
    /* left behind for dropMark()'s own `.collapse` rule to inherit exactly
       what the box-geometry transition used to leave it: opacity alone, at
       the same .4s ease, and no override of `transform` at all. */
    markEl.style.transition = "opacity .4s ease";
    markEl.animate(
      [{ transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` }, { transform: "none" }],
      { duration: ms, easing: "cubic-bezier(.35,0,.2,1)", fill: "none" },
    );
  }
  /** #1151 W1-Q3: the one place both dropMark() and reset() restore the
   *  lockup glyphs' visibility, so a glyph added or renamed here is added
   *  or renamed for both call sites, not just whichever one a future edit
   *  happens to touch. */
  function restoreGlyphVisibility() {
    for (const el of /** @type {NodeListOf<SVGElement>} */ (
      document.querySelectorAll("#login-glyph svg,#dusk-glyph svg")
    )) el.style.visibility = "";
  }
  function dropMark() {
    markEl.classList.remove("on");
    markEl.classList.add("collapse");
    restoreGlyphVisibility();
  }
  /* THE MARK IS FLOWN THROUGH (#1253 ruling 4, orbit-site flight.js
     flyThroughMark): as the climb comes up to speed the ring opens past the
     edges of the screen, a thin hoop the camera goes through, tipping a
     little as the climb steepens, and the gold planet sweeps by close and is
     gone; the dawn's mark is set back behind it, unseen. Reduced motion, a
     mark with no circles, and a pinned fixture (whose frame must hold still)
     drop it as before. */
  /** @type {Animation[]} */
  let flyThrough = [];
  /** @param {boolean} instant */
  function flyThroughMark(instant) {
    restoreGlyphVisibility();
    const svg = markEl.querySelector("svg"), circles = svg ? [...svg.querySelectorAll("circle")] : [];
    if (!svg || !circles.length || instant || reduced()) { dropMark(); return; }
    const timing = { duration: 760, easing: "cubic-bezier(.5,0,.9,.5)", fill: /** @type {const} */ ("forwards") };
    /* the ring's line and halos keep the width they were drawn at (the glyph's
       200-unit box on screen) while they grow: non-scaling-stroke measures in
       screen pixels, so the width is handed over in them */
    const k = svg.getBoundingClientRect().width / 200;
    for (const c of /** @type {SVGElement[]} */ ([...svg.querySelectorAll("[data-w]")])) {
      c.style.vectorEffect = "non-scaling-stroke";
      c.style.strokeWidth = Number(c.dataset.w) * k + "px";
    }
    /* everything but the core grows from the ring's centre: the discs, halos
       and line, and the planet with its wake (the group), which sweeps by */
    const grow = [...circles, .../** @type {SVGElement[]} */ ([...svg.querySelectorAll(".tr")])];
    const anims = grow.map((c) => {
      Object.assign(c.style, { transformOrigin: "100px 100px", transformBox: "view-box" });
      return c.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(2.4)", opacity: 1, offset: 0.5 }, { transform: "scale(9)", opacity: 0 }], timing);
    });
    anims.push(svg.animate([{ transform: "none" }, { transform: "rotateX(-16deg)" }], timing));
    flyThrough = anims;
    anims[0].finished.then(() => {
      markEl.style.transition = "none"; markEl.classList.remove("on");
      setTimeout(() => { if (flyThrough === anims) settleFlyThrough(); markEl.style.transition = ""; }, 120);
    }).catch(() => {});
  }
  /** Put the mark's ring and planet back as they were drawn. */
  function settleFlyThrough() {
    for (const a of flyThrough) a.cancel();
    flyThrough = [];
    for (const el of /** @type {SVGElement[]} */ ([...(markEl?.querySelectorAll("[data-w]") ?? [])])) {
      el.style.vectorEffect = ""; el.style.strokeWidth = "";
    }
  }
  /* the way down: the mark appears at centre and rides to the lockup's glyph.
     Same FLIP treatment as liftMark above, mirrored: the box goes straight to
     its resting geometry (the glyph's own rect) and the visual start (centre
     screen, 36px) is the transform overlay `flip()` plays off. */
  /** @param {boolean} instant */
  function landMark(instant) {
    const from = { left: innerWidth / 2 - 18, top: innerHeight / 2 - 18, width: 36, height: 36 };
    markEl.style.transition = "none";
    markEl.style.left = from.left + "px"; markEl.style.top = from.top + "px";
    markEl.style.width = from.width + "px"; markEl.style.height = from.height + "px";
    markEl.classList.remove("collapse"); markEl.classList.add("on");
    const glyph = /** @type {SVGElement | null} */ (document.querySelector("#dusk-glyph svg"));
    if (!glyph) return;
    const g = glyph.getBoundingClientRect();
    glyph.style.visibility = "hidden";
    markEl.style.left = g.left + "px"; markEl.style.top = g.top + "px";
    markEl.style.width = g.width + "px"; markEl.style.height = g.height + "px";
    if (!instant) flip(from, g.left, g.top, g.width, g.height, MARK_RIDE_DOWN);
  }

  /** @typedef {{ name: string, bodies: Array<[number, number, string, number]> }} PassingHome */
  /** The other households with their tones read as colours, now. */
  function paintedHomes() {
    const style = getComputedStyle(document.body);
    /** @param {string} tone */
    const colour = (tone) => (tone.startsWith("--") ? style.getPropertyValue(tone).trim() : tone) || "#8fb8ff";
    return /** @type {PassingHome[]} */ (homes).map((h) => ({ name: h.name, bodies: h.bodies.map((b) => /** @type {[number, number, string, number]} */ ([b[0], b[1], colour(b[2]), b[3]])) }));
  }
  /** The climb, carrying the other households past. */
  function upProfile() {
    return { ...UP, props: [...PROPS_UP, ...homeProps(paintedHomes())] };
  }
  /** The descent, meeting them the other way. */
  function downProfile() {
    return { ...DOWN, props: [...PROPS_DOWN, ...mirrored(homeProps(paintedHomes()))] };
  }

  /** @param {number | undefined} pinned */
  function ascentStep(pinned) {
    /** @param {string} act */
    return (act) => {
      const b = body();
      switch (act) {
        case "arming": b.classList.add("arming"); break;
        case "warp":
          b.classList.add("showwarp");
          activeEngine().start(upProfile(), pinned === undefined ? {} : { at: Math.min(pinned, UP.dur) });
          clock.stalls(activeEngine().drawingWorld);
          break;
        case "mark":
          b.classList.remove("arming");
          liftMark(document.querySelector("#login-glyph svg"), innerHeight * 0.5,
                   MARK_ARRIVE, MARK_RIDE_UP, pinned !== undefined);
          break;
        case "release": b.classList.remove("showdawn"); break;
        case "markOut": flyThroughMark(pinned !== undefined); break;
        case "nameOn": nameEl.classList.add("on"); break;
        case "nameOff": nameEl.classList.remove("on"); break;
        case "land":
          b.classList.remove("showwarp", "launching");
          b.classList.add("bare");
          onland();
          break;
        case "instrument":
          b.classList.remove("bare");
          b.classList.add("instrument");
          onsettled();
          break;
        /* THE COUNT (the newcomer's and the invited reader's landing alike): a
           moment on the settled sky, boxless, and then the question — or,
           landing "invited", the move — in the space it left. */
        case "countOn": b.classList.add("counting"); break;
        case "countOff": b.classList.remove("counting"); break;
        case "belong": if (landing === "invited") onbelong(); else b.classList.add("belong"); break;
      }
    };
  }

  /** @param {number | undefined} pinned */
  function descentStep(pinned) {
    /** @param {string} act */
    return (act) => {
      const b = body();
      switch (act) {
        case "withdraw":
          b.classList.remove("instrument");
          b.classList.add("withdrawing");
          break;
        case "disperse": b.classList.add("dispersing"); break;
        case "warp":
          b.classList.add("showwarp");
          activeEngine().start(downProfile(), pinned === undefined
            ? {} : { at: Math.min(Math.max(0, pinned - D.warp), DOWN.dur) });
          /* #1262: no stall cap here. The reader is already signed out and
             the dusk is owed on time, so the descent keeps real time as it
             did on dev, and a slow frame is a dropped frame, never a later
             farewell (descend() clears the climb's cap). */
          break;
        /* The mockup drops `descending` here because its home frame has a
           hidden base state to fall back to; a real screen does not, so the
           class that holds the landing off the screen STAYS to the end of the
           descent. (Named `dispersing` and not the mockup's `descending`:
           this app already spends that word on retrograde's scroll descent,
           on <html>, and two meanings of one class is a trap.) */
        case "release": b.classList.remove("withdrawing"); break;
        case "nameOn": nameEl.classList.add("on"); break;
        case "nameOff": nameEl.classList.remove("on"); break;
        case "dusk": b.classList.add("showdusk"); break;
        case "markIn": landMark(pinned !== undefined); break;
        case "warpOut": b.classList.remove("showwarp"); break;
        case "markHome": {
          markEl.classList.remove("on");
          const glyph = /** @type {SVGElement | null} */ (document.querySelector("#dusk-glyph svg"));
          if (glyph) glyph.style.visibility = "";
          break;
        }
        case "farewell": b.classList.add("farewell"); onfarewell(); break;
      }
    };
  }

  /** Clear everything this component ever put on the document. */
  export function reset() {
    cancelTimeline();
    engine?.clear();
    body().classList.remove("arming", "showdawn", "showwarp", "launching", "bare",
                            "instrument", "withdrawing", "dispersing", "showdusk",
                            "farewell", "pinned", "counting", "belong");
    body().classList.remove("holding");
    clock.stalls(false);
    markEl?.classList.remove("on", "collapse");
    nameEl?.classList.remove("on");
    restoreGlyphVisibility();
    if (markEl) settleFlyThrough();
  }

  /**
   * THE LAUNCH. `at` pins it to one millisecond of the journey instead of
   * playing it — the fixtures' way of holding a moving thing still.
   * @param {{ at?: number }} [options]
   */
  export function ascend({ at } = {}) {
    cancelTimeline();
    subtitleText = subtitle;
    const pinned = typeof at === "number";
    if (pinned) body().classList.add("pinned");
    /* "invited" flies the newcomer's own beats too (see the prop's own note):
       only landing "home" gets the plain ascent. */
    const newcomer = landing !== "home";
    if (reduced()) {
      cancelTimeline = runTimeline(
        newcomer ? newcomerAscentBeatsReduced() : ascentBeatsReduced(),
        ascentStep(pinned ? at : undefined), pinned ? { at } : {});
      return;
    }
    if (pinned) {
      cancelTimeline = runTimeline(newcomer ? newcomerAscentBeats() : ascentBeats(), ascentStep(at), { at });
      return;
    }
    /* #1253: the flight's world (voyage.js), readied now and hurried. If it
       is not ready yet the journey still starts at once, but its opening is
       the mark lifting to the centre (which needs nothing drawn), and the
       clock holds just before the warp until the world is ready -- two
       seconds at most (#1222; the arrival has been readying it since before
       its answers came, so what is left to wait for is short), and then the
       flight goes on its own canvas, as ever. The hold is on a lit frame: the
       dawn is up (showdawn, set before the flight starts) and the mark is
       already at the centre, breathing. */
    let beats = newcomer ? newcomerAscentBeats() : ascentBeats();
    const engine = activeEngine();
    readyFlight({ hurry: true });
    const ready = engine.warm();
    if (!engine.world) {
      const warp = beats.find((b) => b.act === "warp")?.at ?? 0;
      beats = beats.map((b) => (b.act === "mark" ? { ...b, at: Math.min(b.at, Math.max(0, warp - 80)) } : b));
      body().classList.add("holding");
      clock.holdAt(Math.max(0, warp - 10), ready.finally(() => body().classList.remove("holding")), WORLD_WAIT);
    }
    cancelTimeline = runTimeline(beats, ascentStep(undefined), clock);
  }

  /**
   * THE DESCENT — the launch played backwards, in the DOM as on the canvas.
   * @param {{ at?: number }} [options]
   */
  export function descend({ at } = {}) {
    cancelTimeline();
    /* #1262: the climb's warp left the stall cap on (ascentStep); the descent
       keeps real time, or a slowly drawn world stretches it out of reach */
    clock.stalls(false);
    subtitleText = "signing out";
    const pinned = typeof at === "number";
    if (pinned) body().classList.add("pinned");
    if (reduced()) {
      cancelTimeline = runTimeline(descentBeatsReduced(), descentStep(pinned ? at : undefined),
                                   pinned ? { at } : {});
      return;
    }
    /* the descent never waits: home readied its world when the sign-out was
       armed, and if it is not ready by the warp the descent flies on its own
       canvas, as ever (engine.js decides at the warp) */
    if (!pinned) {
      const engine = activeEngine();
      readyFlight({ hurry: true, gentle: true }).then(() => engine.warm({ make: false }));
    }
    cancelTimeline = runTimeline(descentBeats(), descentStep(pinned ? at : undefined),
                                 pinned ? { at } : clock);
  }
</script>

<canvas id="warp" aria-hidden="true" bind:this={canvas}></canvas>
<div id="flightmark" aria-hidden="true" bind:this={markEl}>
  <!-- Drawn as the door's own glyph (Dawn.svelte / Dusk.svelte, which are
       identical here): the lit gradient line with its two halos, the dark and
       warm discs, the gold planet picture and its wake, all on the glyph's
       200-unit box with the ring at r72 and the planet at (163, 63.5), because
       that is the mark the swap takes over from — a flatter ring here would
       be the ring turning plain the moment the journey starts. The gradient
       ids carry an fm- prefix so they never meet the glyphs' own on one page.
       The white core is the one thing the glyph does not have — it is the
       heart lighting as the ring leaves, and the point the sun blooms from. -->
  <svg viewBox="0 0 200 200">
    <defs>
      <linearGradient id="fm-ringlit" gradientUnits="userSpaceOnUse" x1="0" y1="26" x2="0" y2="174"><stop offset="0" stop-color="#6c76a0" stop-opacity=".6"/><stop offset=".5" stop-color="#aab2cf" stop-opacity=".85"/><stop offset=".86" stop-color="#ead2a4"/><stop offset="1" stop-color="#ffe2a8"/></linearGradient>
      <radialGradient id="fm-disclit" cx="100" cy="100" r="72" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03040a" stop-opacity=".55"/><stop offset=".8" stop-color="#05070f" stop-opacity=".35"/><stop offset="1" stop-color="#05070f" stop-opacity="0"/></radialGradient>
      <radialGradient id="fm-discwarm" cx="100" cy="182" r="70" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffcf8a" stop-opacity=".16"/><stop offset="1" stop-color="#ffcf8a" stop-opacity="0"/></radialGradient>
      <linearGradient id="fm-trail" gradientUnits="userSpaceOnUse" x1="46.5" y1="51.8" x2="163" y2="63.5"><stop offset="0" stop-color="#ffd68c" stop-opacity="0"/><stop offset=".46" stop-color="#ffd68c" stop-opacity=".08"/><stop offset="1" stop-color="#ffdea0" stop-opacity=".75"/></linearGradient>
    </defs>
    <g class="lux"><circle class="fm-disc" cx="100" cy="100" r="71" fill="url(#fm-disclit)"/><circle class="fm-disc" cx="100" cy="100" r="71" fill="url(#fm-discwarm)"/></g>
    <g class="lux"><circle class="fm-halo" data-w="9" cx="100" cy="100" r="72" fill="none" stroke="url(#fm-ringlit)" stroke-width="9" stroke-opacity=".05"/>
    <circle class="fm-halo" data-w="3.6" cx="100" cy="100" r="72" fill="none" stroke="url(#fm-ringlit)" stroke-width="3.6" stroke-opacity=".12"/></g>
    <circle class="fm-line" data-w="1.6" cx="100" cy="100" r="72" fill="none" stroke="url(#fm-ringlit)" stroke-width="1.6"/>
    <circle class="core" cx="100" cy="100" r="7"/>
    <g class="tr"><path d="M46.5 51.8 A72 72 0 0 1 163 63.5" fill="none" stroke="url(#fm-trail)" stroke-width="3.2" stroke-linecap="round"/><image class="fm-planet" href="/flight/door/planet-gold.webp" x="145" y="45.5" width="36" height="36"/></g>
  </svg>
</div>
<div id="launchname" aria-hidden="true" bind:this={nameEl}>{name}<i>{subtitleText}</i></div>
