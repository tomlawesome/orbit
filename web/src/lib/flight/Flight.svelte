<script>
  import { onMount } from "svelte";
  import { door, UP, PROPS_UP, compilesAside, hurryChores, openChores } from "$lib/door-host.js";
  import { passingHomes, paintedHomes } from "./homes.js";
  import { mayReadyWorld, readyWorldAtLeisure } from "./ready-gate.js";
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
    return () => {
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

  /**
   * Whether the speculative asks hold off: the reader has asked the browser to
   * save data (orbit-site main.js:70). Only the gentle asks (the door's, home's
   * on the sign-out's first tap): the flight itself, once it starts, still asks
   * for what it needs.
   */
  const savingData = () => !!(/** @type {any} */ (navigator)).connection?.saveData;

  /**
   * THE FLIGHT'S WORLD, READIED (#1253; the folder's `journey.warm()`, README.md:
   * the journey). The world is the folder's: it makes it, puts its pictures on
   * the GPU as chores, and proves it fit (a few test frames, each visit,
   * nothing remembered: orbit-site ADR-0002). Under reduced motion there is no
   * flight, so nothing is readied. This only decides WHEN, and returns a promise
   * that settles when the folder has done.
   *   hurry: the flight is wanted now, so what is queued for it goes first.
   *   gentle: only where the compile cannot stop the page (the browser makes
   *     its shaders off the page's thread), and never under save-data.
   *   compile: with gentle, make the world even where the browser compiles on
   *     the page's own thread (Firefox, Safari), for a caller that has chosen a
   *     quiet moment for the pause (#1299).
   *   prove: the test frames too; false is the speculative ask.
   * Whether to ask at all is ready-gate.js's (tested as code).
   * @param {{ hurry?: boolean, gentle?: boolean, compile?: boolean, prove?: boolean }} [how]
   * @returns {Promise<void>}
   */
  export function readyWorld({ hurry = false, gentle = false, compile = false, prove = true } = {}) {
    if (!journey || !mayReadyWorld({ journey: true, reduced: reduced(), gentle, compile, savingData, compilesAside })) return Promise.resolve();
    if (hurry) hurryChores("flight"); else openChores();
    return journey.warm({ prove }).then(() => {}, () => {});
  }

  /**
   * orbit-site's "a little later" (main.js: warmJourneys on arriving anywhere
   * but the door), for a page that is not the door: the world is readied once
   * the page has had a few seconds and its painted animations have finished
   * (the folder's `journey.later()`), so the chores, which touch the GPU, never
   * run under a reveal still being drawn (#1299). Where the browser compiles on
   * the page's own thread (Firefox) it still makes the world: one pause of
   * about a second while the page is quiet, which is the owner's choice
   * (#1299). The folder drops it if a flight or a descent begins first: a
   * compile on the page's thread, started mid-flight, is a pause in the middle
   * of it. A speculative ask: no test frames (`prove: false`); the flight's own
   * ask proves it fit.
   * @param {{ after?: number }} [how]  after: ms from now (orbit-site's four
   *   seconds when left out)
   * @returns {() => void} stops it, if the page is left first
   */
  export function readyAtLeisure(how = {}) {
    return readyWorldAtLeisure({ journey, reduced: reduced(), savingData: savingData(), ready: readyWorld, how });
  }

  /**
   * THE LAUNCH.
   * @param {{ at?: number }} [options]  at: a fixture's moment, in ms into the
   *   journey as it plays: the folder pins the journey there (README.md: `at`).
   *   Orbit's own `pinned` class on the body turns the transitions off while it
   *   stands (flight.css, arrival.css); reset() takes it off.
   */
  export function ascend({ at } = {}) {
    if (!journey) return;
    cancelCount();
    const pinned = typeof at === "number";
    if (pinned) body().classList.add("pinned");
    /* "invited" flies the newcomer's own beats too: only landing "home" ends
       at the instrument */
    const newcomer = landing !== "home";
    /* #1253: the flight's world, readied now and hurried. If it is not ready
       yet the journey still starts at once, and the folder's clock holds just
       before the canvas comes up until it is, for up to eight seconds. A
       machine refused the GPU has `ready` at once, so it never waits. A pinned
       climb waits for nothing and asks for no world. */
    /** @type {any} the folder's JSDoc types `ready` by its default, null */
    const ready = reduced() || pinned ? null : readyWorld({ hurry: true });
    journey.fly({ ...UP, props: [...PROPS_UP, ...passingHomes(paintedHomes(homes))] }, {
      title: name,
      subtitle,
      ready,
      at,
      on: {
        land: () => onland(),
        settled: () => { onsettled(); if (newcomer) count(); },
      },
    });
  }

  /**
   * THE DESCENT: the launch played backwards, in the DOM as on the canvas.
   * It never waits: the world was readied when the sign-out was armed (or at
   * leisure, well before), and if it is not proved by the warp the descent
   * flies painted, on its own canvas (the folder decides at the warp). The
   * other households are met again on the way down: this descent is not
   * flown `from` a climb that carried them, so they are passed as `homes`
   * (the folder's `journey.descend({ homes })`).
   * @param {{ at?: number }} [options]  at: a fixture's moment (ascend, above)
   */
  export function descend({ at } = {}) {
    if (!journey) return;
    cancelCount();
    if (typeof at === "number") body().classList.add("pinned");
    journey.descend({
      title: name,
      subtitle: "signing out",
      onto: "dusk",
      homes: paintedHomes(homes),
      at,
      on: { farewell: () => onfarewell() },
    });
  }
</script>

<canvas id="warp" aria-hidden="true" bind:this={canvas}></canvas>
<div id="launchname" aria-hidden="true" bind:this={nameEl}></div>
