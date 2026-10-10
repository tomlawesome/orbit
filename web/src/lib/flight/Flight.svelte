<script>
  import { onMount } from "svelte";
  import { door, UP, PROPS_UP } from "$lib/door-host.js";
  import { homeProps, paintedHomes } from "./homes.js";
  import { readyFlight, useJourney } from "./warm.js";
  import "$lib/door/door.css";
  import "./flight.css";

  /**
   * THE FLIGHT, as a surface (#410, §15).
   *
   * The journey is the shared door's (#1371): the folder's `door.journey()`
   * owns the canvas and the household's name written once on the void, keeps
   * the journey's own clock, and says WHEN, in the body-class vocabulary the
   * stylesheets answer. The dawn and the dusk are the host's (they are also
   * screens in their own right), and the landing is the host's too: this
   * component hands the journey Orbit's flight (the climb, with the reader's
   * other households passing) and Orbit's hooks, and adds what is Orbit's own
   * after the landing: the newcomer's count (#1371 note 33895: off the
   * folder's `settled` hook, on Orbit's own timers and classes).
   *
   * THE ONE HONEST DEVIATION — see also the note on the sign-in gate.
   * The mockup plays ignition → climb → reveal → landing unbroken from the
   * press of the button. The product cannot: the press leaves Orbit for the
   * identity provider, and the browser returns on a new document. So the
   * journey is cut at the only place reality cuts it — the departure — and
   * the launch itself plays whole on the authenticated return, before home
   * settles.
   */
  let {
    /* the household's name, written on the void at the top of the climb */
    name = "",
    /* what the void says underneath it */
    subtitle = "welcome back",
    /*
     * WHERE THE CLIMB SETS DOWN (§15 second pass, ruling 4): "home" is the
     * landing every member gets, and "newcomer" is the one a reader who
     * belongs to nothing yet gets — the same flight to the millisecond, and
     * the count's own three beats after it. The host draws both; this only
     * says when.
     *
     * "invited" (#871) flies the identical newcomer beats and differs at
     * exactly one beat: see `onbelong` below.
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
     * any frame, so the class is never added and this fires instead.
     */
    onbelong = () => {},
    /* the descent has finished: the reader is on the dusk */
    onfarewell = () => {},
    /*
     * THE OTHER HOUSEHOLDS (#1253 ruling 3): the reader's real other
     * households, passed on the climb, as homes.js `othersOf` reads them from
     * the galaxy. Each is { name, bodies: [[x, y, tone, r]] }.
     */
    homes = [],
  } = $props();

  /** @type {HTMLCanvasElement} */
  let canvas;
  /** @type {HTMLDivElement} */
  let nameEl;
  /** @type {ReturnType<typeof door.journey> | null} */
  let journey = null;

  const body = () => document.body;
  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /*
   * THE NEWCOMER'S COUNT (#1222; the count sealed in the §15 third pass and
   * retimed in #870, restored by the owner, 2026-10-07), counted from the
   * instrument's arrival (the folder's `settled`):
   *     +300   the count fades IN on the settling sky, boxless (0.45s)
   *    +3500   it fades OUT again (0.45s)
   *    +4400   and the question arrives in the space it left
   * Under reduced motion the count still takes its turn — it appears, holds
   * 1.9 s, and yields to the question; only the fade is dropped.
   */
  const COUNT = { on: 300, off: 300 + 3200, belong: 300 + 3200 + 900 };
  const COUNT_REDUCED = { on: 0, off: 1900, belong: 1900 };
  /** @type {ReturnType<typeof setTimeout>[]} */
  let counting = [];
  function cancelCount() {
    counting.forEach(clearTimeout);
    counting = [];
  }
  function count() {
    const at = reduced() ? COUNT_REDUCED : COUNT;
    const b = body();
    counting = [
      setTimeout(() => b.classList.add("counting"), at.on),
      setTimeout(() => b.classList.remove("counting"), at.off),
      setTimeout(() => { if (landing === "invited") onbelong(); else b.classList.add("belong"); }, at.belong),
    ];
  }

  onMount(() => {
    const j = door.journey({
      canvas,
      name: nameEl,
      dawnGlyph: () => document.querySelector("#login-glyph svg"),
      duskGlyph: () => document.querySelector("#dusk-glyph svg"),
    });
    journey = j;
    const letGo = useJourney(j);
    return () => {
      letGo();
      cancelCount();
      j.destroy();
      body().classList.remove("pinned", "counting", "belong");
      journey = null;
    };
  });

  /** Clear everything this component ever put on the document. */
  export function reset() {
    cancelCount();
    journey?.reset();
    body().classList.remove("pinned", "counting", "belong", "holding");
  }

  /*
   * #1371: waits for ai/orbit-site#23 -- the folder's fly()/descend() take
   * `at` and pin the journey at that moment; until then a fixture's `at` is
   * flown live. When it lands: the folder does NOT add `body.pinned`, so this
   * component adds it before the pinned call and removes it in reset()
   * (Orbit's CSS turns transitions off with it: arrival.css, Chrome.svelte);
   * and a pinned climb draws about 200 ms earlier than the port did for the
   * same `at` (the door starts the engine at `at` less the warp beat, as the
   * live flight does), which no fidelity screenshot covers.
   */

  /**
   * THE LAUNCH.
   * @param {{ at?: number }} [_options] a fixture's moment (above)
   */
  export function ascend(_options = {}) {
    if (!journey) return;
    cancelCount();
    /* "invited" flies the newcomer's own beats too: only landing "home" ends
       at the instrument */
    const newcomer = landing !== "home";
    /* #1253: the flight's world, readied now and hurried. If it is not ready
       yet the journey still starts at once, and the folder's clock holds just
       before the canvas comes up until it is, for up to eight seconds. A
       machine refused the GPU has `ready` at once, so it never waits. */
    /** @type {any} the folder's JSDoc types `ready` by its default, null */
    const ready = reduced() ? null : readyFlight({ hurry: true });
    /* #1371: homeProps waits for ai/orbit-site#24 (homes.js) */
    journey.fly({ ...UP, props: [...PROPS_UP, ...homeProps(paintedHomes(homes))] }, {
      title: name,
      subtitle,
      ready,
      on: {
        land: () => onland(),
        settled: () => { onsettled(); if (newcomer) count(); },
      },
    });
  }

  /**
   * THE DESCENT — the launch played backwards, in the DOM as on the canvas.
   * It never waits: home readied its world when the sign-out was armed, and
   * if it is not ready by the warp the descent flies on its own canvas.
   * #1371: the other households are not met on the way down. The folder's
   * descent carries a climb's traffic only as `from`, which sets down on the
   * dawn rather than the dusk (journey.js descentFrom): a gap in the folder.
   * @param {{ at?: number }} [_options] a fixture's moment (ascend, above)
   */
  export function descend(_options = {}) {
    if (!journey) return;
    cancelCount();
    readyFlight({ hurry: true, gentle: true });
    journey.descend({ title: name, subtitle: "signing out", onto: "dusk", on: { farewell: () => onfarewell() } });
  }
</script>

<canvas id="warp" aria-hidden="true" bind:this={canvas}></canvas>
<div id="launchname" aria-hidden="true" bind:this={nameEl}></div>
