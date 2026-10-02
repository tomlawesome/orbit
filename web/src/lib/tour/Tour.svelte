<script>
  import { onMount, tick } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { readTour, writeTourSeen } from "$lib/data/workspace.js";
  import { isPocket } from "$lib/pocket/media.js";
  import { createFilm } from "./film.js";
  import { tourHasSomethingToShow } from "./offer.js";
  import { onRestartInPlace, tourMayBegin } from "./relaunch.js";
  import { beginFilm } from "./trigger.js";

  /**
   * THE FIRST-RUN FILM (#866, pocket cut #1083) — the trigger, and the
   * decision to put it up.
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
   * THE DIALECT (#1083). The film now plays on every viewport: `pocket:
   * isPocket()` (the same switch the product's own screens pick their own
   * dialect with, CON-10) is handed to `createFilm` and on into
   * `createFilmContext`, so a chapter can choose pocket selectors and anchors
   * without ever calling `matchMedia` itself. See §24's shipped note in
   * design/owner-decisions.md for what this ends.
   *
   * The gate itself — give up quietly if `readTour` throws, nothing for a
   * household-less reader — lives in trigger.js's `beginFilm`, framework-free
   * so it is unit-testable without a mounted component. This file is the
   * wiring: it hands `beginFilm` the real `readTour`, the real household
   * check and a function that builds the real film.
   */
  const HOME = "/home";
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
    /* #1174: the pocket's belt chapter walks the row's own `open →` act to a
       named item — one that carries documents — rather than whichever rides
       at the apex. The id is the act's own href's, never typed here. */
    const item = /^\/item\/([^/?#]+)$/u.exec(route);
    if (item) return goto(resolve("/item/[[id]]", { id: item[1] }));
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
      readTour,
      hasHousehold: () => tourHasSomethingToShow(document),
      createFilmRun: () => {
        /* A second take on the same load (#753, #1189) leaves nothing of the
           first behind. */
        film?.destroy();
        film = createFilm({
          doc: document,
          pocket: isPocket(),
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
  /* A relaunch from a menu while already on /home (#1189) changes no path,
     so it bumps this instead; the effect below reads it to run again. */
  let restarts = $state(0);
  $effect(() => {
    void restarts;
    if (page.url.pathname !== HOME || !tourMayBegin(started)) return;
    started = true;
    void begin();
  });

  onMount(() => {
    const stopListening = onRestartInPlace(() => restarts++);
    return () => {
      stopListening();
      film?.destroy();
    };
  });
</script>
