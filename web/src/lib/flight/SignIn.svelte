<script>
  import { onMount } from "svelte";
  import Grain from "$lib/Grain.svelte";
  import Dawn from "./Dawn.svelte";
  import { clearLaunch, markLaunch } from "./arrival.js";
  import { DOOR, FAILED, STARTING, availabilityOf, doorMessageFor, nextDoorState, phaseOf, readinessOf } from "./door-state.js";
  import "./flight.css";

  /**
   * THE SIGN-IN (#410, §15).
   *
   * The owner ratified the login/logout flight verbatim on 2026-08-16 —
   * "nothing short of amazing... Ship these in that exact form" — and ruled in
   * the same breath that they are NOT first-run dressing: they ship as THE
   * login and logout screens for every user, every time; first-run just
   * happens to use them. So this screen is design/v19/first-run.html's login
   * layer, drawn as it draws it: the dawn limb, and — since the owner's
   * 2026-08-17 correction, applied to sheet and app together — the 2026-08-14
   * lockup on top of it: the ring large and centred, `orbit` inside it, the
   * small gold pill inside the ring beneath the word, and no ribbon and no
   * footer anywhere on the screen.
   *
   * THE HONEST DEVIATION, stated where it happens. The mockup's flight runs
   * unbroken from this button. Pressing it in the product leaves Orbit for the
   * identity provider, so the journey is cut at the departure and nowhere
   * else: the gate flashes over the mockup's own 420 → 900ms window, and at
   * 900 — exactly the beat the mockup hands over to the climb — this page
   * hands over to /api/auth/login instead. The climb itself, whole and
   * unaltered, plays on the authenticated return (see Flight.svelte and the
   * launch overlay on /home). A one-shot marker written here and consumed
   * there is what tells the landing that a genuine sign-in just happened; see
   * arrival.js for why that is honest and why it cannot replay.
   */
  let {
    /*
     * WHERE THE JOURNEY LANDS. The front door is the arrival's switchboard
     * (#410, §15: "first-run sits ON TOP of the login screen, not its own
     * page"), so a reader coming back from the identity provider comes back
     * to "/" and it decides what they are looking at: home, the create card,
     * or the newcomer's climb. /login hands the same decision on by returning
     * to the same address.
     */
    returnTo = "/",
    /*
     * THE ONE DIFFERENCE THE CREATE PATH HAS (§15, fourth pass, verbatim):
     * "the orbit logo and text reappear and we run the login intro, the only
     * tweak being this time there's no login button as we already passed it."
     * So the identity-provider button — and only that — can be left off,
     * while the dawn, the lockup and the first light stay exactly as ratified.
     */
    gate = true,
    /*
     * The dawn holds itself up on this screen, because this screen IS the
     * dawn. When a flight is about to lift off it, the body class takes the
     * visibility over instead, so the ascent's `release` beat at 430ms has
     * something to release.
     */
    dawnShown = true,
    /* One <title> per document: the arrival's stages stand on this surface, so
       they name it rather than adding a second one. */
    title = "Orbit — sign in",
  } = $props();

  let leaving = false;

  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /*
   * THE THREE STATES WHERE THE DOOR CANNOT OPEN (#788, design/v19/
   * signin-states/round-1/, direction C, owner-ratified 2026-09-06).
   *
   * Default optimistic: the door's own `data-state` starts (and, for a
   * healthy instance, stays) unset — the ordinary button, unchanged from
   * before this issue — so a healthy sign-in shows nothing different at all,
   * and the very first paint (this route is prerendered, static HTML with no
   * JS run yet) is always the door. Only once a check answers with a real
   * problem does `onMount` below set `data-state` at all.
   *
   * The button itself stays in the markup throughout (`{#if gate}`, as
   * before this issue) — flight.css hides `.gate-wrap` by `data-state`,
   * exactly as the ratified sheet does, rather than this component removing
   * and re-inserting the button. That is what lets its ratified 3.6s-delayed
   * entrance replay correctly on recovery: a freshly inserted element has no
   * "before" style to transition from, but a `display:none` element coming
   * back already does. `display:none` still meets the round-1 README's
   * accessibility bar ("not rendered... not merely hidden"): unlike
   * `opacity:0` or `visibility:hidden`, it drops the button from both the
   * layout and the accessibility tree, so it is not reachable by keyboard or
   * screen reader while sign-in is unavailable.
   */
  let statePrimary = $state("");
  let stateSub = $state("");

  /** Fetches JSON, answering `null` for anything that cannot be trusted — a
   *  network failure, a non-2xx the caller still wants the body of, or a
   *  response that is not JSON at all. Never throws. @param {string} url */
  async function fetchJson(url) {
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      return await response.json();
    } catch {
      return null;
    }
  }

  /** One round of both checks (#788, #869): availability first, since its
   *  `phase` field is what decides whether there is any point asking
   *  readiness at all — `phase: "starting"` is `STARTING` regardless of
   *  what `/api/health` would say, so a booting instance costs one request,
   *  not two. Readiness is only fetched once `phase` says boot is done and
   *  a degraded or unreadable answer becomes a fault worth failing on. */
  async function checkOnce() {
    const availabilityBody = await fetchJson("/api/auth/availability");
    const phase = phaseOf(availabilityBody);
    const availability = availabilityOf(availabilityBody);
    const readiness = phase === "running" ? readinessOf(await fetchJson("/api/health")) : null;
    return { state: nextDoorState({ phase, readiness, availability }), contactAddress: availability?.contactAddress ?? null };
  }

  /* The backstop (#869): a process can hang mid-boot without exiting, so the
     STARTING poll cannot run forever on the strength of "boot terminates" alone.
     Not the mechanism — `phase` flipping to "running" is — only the fallback
     for when it never does. */
  const STARTING_BACKSTOP_MS = 120_000;

  onMount(() => {
    /* A marker left over from an abandoned sign-in must never fire later. */
    clearLaunch();

    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = [];
    /** @param {number} ms @param {() => void} fn */
    const after = (ms, fn) => timers.push(setTimeout(fn, ms));
    /* first light: the dawn breaks once on load (CON-9, POL-13) */
    const frame = requestAnimationFrame(() => after(180, () => document.body.classList.add("lit")));

    let disposed = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let pollTimer;

    /**
     * Shows a state other than the door: fixed words, styled to match it.
     * @param {Parameters<typeof doorMessageFor>[0]} state
     * @param {string | null} [contactAddress]
     */
    function showState(state, contactAddress) {
      const message = doorMessageFor(state, contactAddress);
      statePrimary = message.primary;
      stateSub = message.sub;
      document.body.classList.add("switched");
      document.body.dataset.state = state;
    }

    /* The waking instance comes up on its own — no action from the reader
       (round-1 README, "deliberately not done": no Try again control). The
       held sky releases into the ratified first light exactly as it would on
       a fresh, healthy load; only the words fade out first. */
    function recoverToDoor() {
      document.body.classList.add("returning");
      after(reduced() ? 200 : 800, () => {
        if (disposed) return;
        statePrimary = "";
        stateSub = "";
        document.body.dataset.state = DOOR;
        document.body.classList.add("returned");
      });
    }

    async function run() {
      const first = await checkOnce();
      if (disposed || first.state === DOOR) return;
      const wasStarting = first.state === STARTING;
      showState(first.state, first.contactAddress);
      if (!wasStarting) return;

      /* Measured from the first paint of STARTING, not from the server's own
         boot start, which this page never learns. */
      const backstopAt = Date.now() + STARTING_BACKSTOP_MS;
      const poll = async () => {
        if (disposed) return;
        const next = await checkOnce();
        if (disposed) return;
        if (next.state === STARTING) {
          if (Date.now() >= backstopAt) {
            showState(FAILED, next.contactAddress);
            return;
          }
          pollTimer = setTimeout(poll, 4000);
          return;
        }
        if (next.state === DOOR) recoverToDoor();
        else showState(next.state, next.contactAddress);
      };
      pollTimer = setTimeout(poll, 4000);
    }
    run();

    return () => {
      disposed = true;
      clearTimeout(pollTimer);
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      document.body.classList.remove("lit", "switched", "returning", "returned");
      delete document.body.dataset.state;
    };
  });

  /** @param {MouseEvent} event */
  function press(event) {
    const gate = /** @type {HTMLElement} */ (event.currentTarget);
    if (leaving) return;
    leaving = true;
    markLaunch();
    const rm = reduced();
    setTimeout(() => gate.classList.add("flash"), rm ? 0 : 420);
    setTimeout(() => {
      location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    }, rm ? 200 : 900);
  }
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<!-- The mockup's own page ground (#04060e), carried as a layer rather than as
     a rule on <body>: a stylesheet that reached the document would follow the
     reader onto every other screen once its chunk had loaded. -->
<div class="signin-stage" aria-hidden="true"></div>
<Dawn shown={dawnShown} {statePrimary} {stateSub}>
  <!-- `Sign in`, the ratified word (08-14), and the word the sunset's own
       pill was reworded to match. The sheet's longer
       "Continue with your identity provider" belonged to the v18 chrome
       struck on 2026-08-17 — and would not fit inside the ring in any case.
       What it said is still true and is still said, out loud, one screen
       later: pressing this leaves for the identity provider.

       Left off entirely on the create path, where the reader is already
       through it (§15, fourth pass). -->
  {#if gate}<button class="gate" id="gate" onclick={press}>Sign in</button>{/if}
</Dawn>
<Grain slope={0.08} />
