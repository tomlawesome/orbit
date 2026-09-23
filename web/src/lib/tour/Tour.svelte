<script>
  import { onMount, tick } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { readTour, writeTourSeen } from "$lib/data/workspace.js";
  import { createFilm } from "./film.js";
  import { tourHasSomethingToShow } from "./offer.js";
  import { tourMayBegin } from "./relaunch.js";
  import { beginFilm } from "./trigger.js";

  /**
   * THE FIRST-RUN FILM (#866) — the trigger, and the decision to put it up.
   *
   * §23 of design/owner-decisions.md retired the old eight-stop card walk
   * outright ("The only tour is the one with the play and pause buttons.
   * Anything else is old and superseded.") in favour of film.js's one-take
   * film. film.js says plainly it holds no opinion about when it plays, who
   * skips it, or "take it again" — that is this file's job (via trigger.js),
   * same as it was the old engine's.
   *
   * WHY THIS LIVES IN THE LAYOUT. The film crosses /home, /inbox, /create,
   * /item and /settings/mail (chapters/index.js), so it outlives any one page
   * component: mounted here it survives the navigation between them instead
   * of being unmounted mid-chapter. It stays inert everywhere else — the film
   * only ever STARTS on the reader's first landing on /home, and only when
   * the server says they have never taken it (#751's `tourSeenAt`).
   *
   * The gate itself — desk-only (§24), never a phone write, give up quietly
   * if `readTour` throws, nothing for a household-less reader — lives in
   * trigger.js's `beginFilm`, framework-free so it is unit-testable without a
   * mounted component. This file is the wiring: it decides "phone" from the
   * real viewport, and hands `beginFilm` the real `readTour`, the real
   * household check and a function that builds the real film.
   */
  const HOME = "/home";
  /* The same cut home uses to choose between its two dialects (CON-10). */
  const DESK = "(min-width: 901px)";
  /**
   * Walking onto the screen a chapter names. Written as literal navigations
   * rather than one built from the route string, so the router — and the
   * lint rule that guards it — can see every address the film is able to
   * reach. A route naming anywhere else lands on the sky.
   *
   * @param {string} route
   */
  function walkTo(route) {
    if (route === "/inbox") return goto(resolve("/inbox"));
    if (route === "/create") return goto(resolve("/create"));
    if (route === "/item") return goto(resolve("/item"));
    if (route === "/settings/mail") return goto(resolve("/settings/mail"));
    return goto(resolve("/home"));
  }

  /** @type {ReturnType<typeof createFilm> | null} */
  let film = null;
  let started = false;

  /**
   * The ratified login flight owns the arrival, whole and unaltered — the
   * film waits at the gate until it has landed rather than opening over it.
   */
  function landed() {
    if (!document.body.classList.contains("launching")) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => { observer.disconnect(); clearTimeout(patience); done(undefined); };
      const observer = new MutationObserver(() => {
        if (!document.body.classList.contains("launching")) finish();
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      /* A flight that never lands must not silently swallow the film. */
      const patience = setTimeout(finish, 12_000);
    });
  }

  async function begin() {
    await landed();
    await beginFilm({
      phone: !matchMedia(DESK).matches,
      readTour,
      hasHousehold: () => tourHasSomethingToShow(document),
      createFilmRun: () => {
        film = createFilm({
          doc: document,
          routeOf: () => page.url.pathname,
          navigate: walkTo,
          settle: tick,
        });
        return film;
      },
      writeSeen: () => writeTourSeen().catch(() => {}),
    });
  }

  /*
   * `started` alone would make the film a true one-shot for the rest of this
   * page load — right for ordinary navigation, wrong for "take the walk
   * again" (#753): a reader who clears `tourSeenAt` from settings and lands
   * back on /home in the SAME session must still get the film. `tourMayBegin`
   * lets exactly that one arrival through; see relaunch.js.
   */
  $effect(() => {
    if (page.url.pathname !== HOME || !tourMayBegin(started)) return;
    started = true;
    void begin();
  });

  onMount(() => () => film?.destroy());
</script>
