<script>
  import { onMount, tick } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { readTour, writeTourSeen } from "$lib/data/workspace.js";
  import { createTour } from "./engine.js";
  import { tourMayBegin } from "./relaunch.js";
  import { TOUR_REGIONS, stopsFor } from "./stops.js";
  import "./tour.css";

  /**
   * THE FIRST-RUN WALK (#752, slice 2 of #477) — the card, and the decision to
   * put it up.
   *
   * The card is design/v19/tour.html's own: two lines in Orbit's voice, the
   * stop counter, the dots, and *Back*, *Next* and *Skip* always visible. It
   * is a dialog that does NOT trap the page (`aria-modal="false"`), because
   * the walk is a walk: the reader is looking at the real screen behind it,
   * and the thing being explained is described BY these two lines, through the
   * `aria-describedby` the engine puts on it.
   *
   * WHY THIS LIVES IN THE LAYOUT. Stops 6 and 7 are on other screens, so the
   * walk outlives any one page component: mounted here it survives the
   * navigation between /home, /inbox and /settings/mail instead of being
   * unmounted mid-sentence. It stays inert everywhere else — the walk only
   * ever STARTS on the reader's first landing on /home, and only when the
   * server says they have never taken it (#751's `tourSeenAt`).
   */
  const HOME = "/home";
  /* The same cut home uses to choose between its two dialects (CON-10). */
  const DESK = "(min-width: 901px)";
  /**
   * Walking onto the screen a stop names. Written as three literal
   * navigations rather than one built from the stop's string, so the router
   * — and the lint rule that guards it — can see every address the walk is
   * able to reach. A stop naming anywhere else lands on the sky.
   *
   * @param {string} route
   */
  function walkTo(route) {
    if (route === "/inbox") return goto(resolve("/inbox"));
    if (route === "/settings/mail") return goto(resolve("/settings/mail"));
    return goto(resolve("/home"));
  }

  /** @type {import("./engine.js").TourView | null} */
  let view = $state(null);
  /** @type {ReturnType<typeof createTour> | null} */
  let tour = null;
  let started = false;

  /**
   * The ratified login flight owns the arrival, whole and unaltered — the
   * tour waits at the gate until it has landed rather than opening over it.
   */
  function landed() {
    if (!document.body.classList.contains("launching")) return Promise.resolve();
    return new Promise((done) => {
      const finish = () => { observer.disconnect(); clearTimeout(patience); done(undefined); };
      const observer = new MutationObserver(() => {
        if (!document.body.classList.contains("launching")) finish();
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      /* A flight that never lands must not silently swallow the walk. */
      const patience = setTimeout(finish, 12_000);
    });
  }

  async function begin() {
    await landed();
    /** @type {{ tourSeenAt: string | null }} */
    let record;
    try {
      record = await readTour();
    } catch {
      /* Orbit not being able to say whether the walk has been taken is not a
         reason to interrupt someone's sky. Silence, and again next time. */
      return;
    }
    if (record.tourSeenAt !== null) return;
    const phone = !matchMedia(DESK).matches;
    tour = createTour({
      doc: document,
      stops: stopsFor({ phone }),
      regions: TOUR_REGIONS,
      phone,
      routeOf: () => page.url.pathname,
      navigate: walkTo,
      /* The one and only write the walk makes, on skip or on finish. */
      writeSeen: () => writeTourSeen().catch(() => {}),
      onChange: (next) => { view = next; },
      settle: tick,
    });
    await tour.start();
  }

  /*
   * `started` alone would make the walk a true one-shot for the rest of this
   * page load — right for ordinary navigation, wrong for "take the walk
   * again" (#753): a reader who clears `tourSeenAt` from settings and lands
   * back on /home in the SAME session must still get the walk. `tourMayBegin`
   * lets exactly that one arrival through; see relaunch.js.
   */
  $effect(() => {
    if (page.url.pathname !== HOME || !tourMayBegin(started)) return;
    started = true;
    void begin();
  });

  onMount(() => () => tour?.destroy());
</script>

{#if view}
  <div class="tourcard" role="dialog" aria-modal="false" aria-labelledby="tour-progress"
       tabindex="-1" data-tour-stop={view.number}>
    <p class="progress" id="tour-progress">Stop {view.number} of {view.total}</p>
    <p class="copy" id="tour-copy-1">{view.copy[0]}</p>
    <p class="copy second" id="tour-copy-2">{view.copy[1]}</p>
    <div class="dots" aria-hidden="true">
      <!-- one dot per stop, the current one filled -->
      {#each [...Array(view.total).keys()] as dot (dot)}<i class:on={dot === view.index}></i>{/each}
    </div>
    <!-- All three doors are always visible: the walk is skippable at any
         point, and saying so quietly in a corner is not saying so. -->
    <div class="tourbtns">
      <div class="side">
        <button id="tour-back" disabled={view.first} onclick={() => tour?.go(-1)}>Back</button>
        <button id="tour-next" onclick={() => tour?.go(1)}>{view.last ? "Finish" : "Next"}</button>
      </div>
      <button class="skip" id="tour-skip" onclick={() => tour?.skip()}>Skip</button>
    </div>
  </div>
{/if}
