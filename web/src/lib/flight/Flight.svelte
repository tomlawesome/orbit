<script>
  import { onMount } from "svelte";
  import { createFlight, UP, DOWN } from "./engine.js";
  import {
    ascentBeats, ascentBeatsReduced, descentBeats, descentBeatsReduced,
    runTimeline, MARK_RIDE_UP, MARK_RIDE_DOWN, D,
  } from "./timeline.js";
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
    /* the landing: the host reveals its own surface here (bare sky) */
    onland = () => {},
    /* the instrument has arrived and the journey is over */
    onsettled = () => {},
    /* the descent has finished: the reader is on the dusk */
    onfarewell = () => {},
  } = $props();

  let canvas;
  let markEl;
  let nameEl;
  let engine = null;
  let cancelTimeline = () => {};
  /* what the void says under the household's name: the ascent's own word on
     the way up, "signing out" on the way down. Set when a journey starts, so
     it never reads back the other direction's line. */
  let subtitleText = $state("");

  const body = () => document.body;
  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  onMount(() => {
    engine = createFlight(canvas);
    const onResize = () => engine.resize();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      cancelTimeline();
      engine.clear();
      reset();
    };
  });

  /* the mark leaves the lockup and rides to the centre of the screen — and the
     dial's sun, 2s later, blooms out of exactly that point */
  function liftMark(srcSvg, toY, grow, ms, instant) {
    if (!srcSvg) return;
    const r = srcSvg.getBoundingClientRect();
    markEl.style.transition = "none";
    markEl.style.left = r.left + "px"; markEl.style.top = r.top + "px";
    markEl.style.width = r.width + "px"; markEl.style.height = r.height + "px";
    markEl.classList.remove("collapse");
    markEl.classList.add("on");
    srcSvg.style.visibility = "hidden";
    const size = r.width * grow;
    const settle = () => {
      markEl.style.transition = instant ? "none" : rideTransition(ms);
      markEl.style.left = (innerWidth / 2 - size / 2) + "px";
      markEl.style.top = (toY - size / 2) + "px";
      markEl.style.width = size + "px"; markEl.style.height = size + "px";
    };
    if (instant) settle();
    else requestAnimationFrame(settle);
  }
  function rideTransition(ms) {
    return "left " + ms + "ms cubic-bezier(.35,0,.2,1)," +
      "top " + ms + "ms cubic-bezier(.35,0,.2,1)," +
      "width " + ms + "ms cubic-bezier(.35,0,.2,1)," +
      "height " + ms + "ms cubic-bezier(.35,0,.2,1),opacity .4s ease";
  }
  function dropMark() {
    markEl.classList.remove("on");
    markEl.classList.add("collapse");
    for (const el of document.querySelectorAll("#login-glyph svg,#dusk-glyph svg"))
      el.style.visibility = "";
  }
  /* the way down: the mark appears at centre and rides to the lockup's glyph */
  function landMark(instant) {
    markEl.style.transition = "none";
    markEl.style.left = (innerWidth / 2 - 18) + "px";
    markEl.style.top = (innerHeight / 2 - 18) + "px";
    markEl.style.width = "36px"; markEl.style.height = "36px";
    markEl.classList.remove("collapse"); markEl.classList.add("on");
    const glyph = document.querySelector("#dusk-glyph svg");
    if (!glyph) return;
    const g = glyph.getBoundingClientRect();
    glyph.style.visibility = "hidden";
    const settle = () => {
      markEl.style.transition = instant ? "none" : rideTransition(MARK_RIDE_DOWN);
      markEl.style.left = g.left + "px"; markEl.style.top = g.top + "px";
      markEl.style.width = g.width + "px"; markEl.style.height = g.height + "px";
    };
    if (instant) settle();
    else requestAnimationFrame(settle);
  }

  function ascentStep(pinned) {
    return (act) => {
      const b = body();
      switch (act) {
        case "arming": b.classList.add("arming"); break;
        case "warp":
          b.classList.add("showwarp");
          engine.start(UP, pinned === undefined ? {} : { at: Math.min(pinned, UP.dur) });
          break;
        case "mark":
          b.classList.remove("arming");
          liftMark(document.querySelector("#login-glyph svg"), innerHeight * 0.5, 2.6,
                   MARK_RIDE_UP, pinned !== undefined);
          break;
        case "release": b.classList.remove("showdawn"); break;
        case "markOut": dropMark(); break;
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
      }
    };
  }

  function descentStep(pinned) {
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
          engine.start(DOWN, pinned === undefined
            ? {} : { at: Math.min(Math.max(0, pinned - D.warp), DOWN.dur) });
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
          const glyph = document.querySelector("#dusk-glyph svg");
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
                            "farewell", "pinned");
    markEl?.classList.remove("on", "collapse");
    nameEl?.classList.remove("on");
    for (const el of document.querySelectorAll("#login-glyph svg,#dusk-glyph svg"))
      el.style.visibility = "";
  }

  /**
   * THE LAUNCH. `at` pins it to one millisecond of the journey instead of
   * playing it — the fixtures' way of holding a moving thing still.
   */
  export function ascend({ at } = {}) {
    cancelTimeline();
    subtitleText = subtitle;
    const pinned = typeof at === "number";
    if (pinned) body().classList.add("pinned");
    if (reduced()) {
      cancelTimeline = runTimeline(ascentBeatsReduced(), ascentStep(pinned ? at : undefined),
                                   pinned ? { at } : {});
      return;
    }
    cancelTimeline = runTimeline(ascentBeats(), ascentStep(pinned ? at : undefined),
                                 pinned ? { at } : {});
  }

  /** THE DESCENT — the launch played backwards, in the DOM as on the canvas. */
  export function descend({ at } = {}) {
    cancelTimeline();
    subtitleText = "signing out";
    const pinned = typeof at === "number";
    if (pinned) body().classList.add("pinned");
    if (reduced()) {
      cancelTimeline = runTimeline(descentBeatsReduced(), descentStep(pinned ? at : undefined),
                                   pinned ? { at } : {});
      return;
    }
    cancelTimeline = runTimeline(descentBeats(), descentStep(pinned ? at : undefined),
                                 pinned ? { at } : {});
  }
</script>

<canvas id="warp" aria-hidden="true" bind:this={canvas}></canvas>
<div id="flightmark" aria-hidden="true" bind:this={markEl}>
  <svg viewBox="0 0 200 200">
    <circle cx="100" cy="100" r="72" fill="none" stroke="#e9edf8" stroke-width="6" opacity=".85"/>
    <circle class="core" cx="100" cy="100" r="7"/>
    <circle cx="163" cy="63.5" r="15" fill="#d8b45a"/>
  </svg>
</div>
<div id="launchname" aria-hidden="true" bind:this={nameEl}>{name}<i>{subtitleText}</i></div>
