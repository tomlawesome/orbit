<script>
  import { onMount, tick } from "svelte";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import SignIn from "$lib/flight/SignIn.svelte";
  import Flight from "$lib/flight/Flight.svelte";
  import { consumeLaunch, markLaunch } from "$lib/flight/arrival.js";
  import { readyFlight } from "$lib/flight/warm.js";
  import { applyCommand, readWorkspace, requestToJoin } from "$lib/data/workspace.js";
  import { labelledSkyOf } from "$lib/data/chart.js";
  import { ARRIVAL_FIXTURES } from "$lib/data/fixtures/arrival.js";
  import Newcomer from "./Newcomer.svelte";
  import {
    ASKING, DOOR, INVITED, NEWCOMER, ONWARD,
    arrivalStageOf, collidingHouseholdOf, createSystemCommand, isInvitedLanding,
    preferredCurrency, preferredTimeZone,
  } from "./stage.js";
  /* The ring and the card themselves (#914): shared with the sign-in door's
     four cards since the owner's 2026-09-09 composition ruling, and drawn
     here by SignIn's own door. arrival.css keeps only the newcomer's landing
     and its create drawer (#1263). */
  import "$lib/ringcard.css";
  import "./arrival.css";

  /**
   * THE ARRIVAL — the front door's stages (#410, §15).
   *
   * THE LAW (owner, 2026-08-16, sealed): "the first-run screen was too plain
   * and it doesn't get its own page — it sits ON TOP of the login screen." So
   * there is no /first-run and no /welcome. This one surface is the door, and
   * what stands on it depends on who knocks:
   *
   *   door      · signed out, or not yet answered. The ratified sign-in,
   *               untouched — and the honest thing to draw while the server is
   *               still being asked, because it is the one surface on this page
   *               that needs no answer.
   *   newcomer  · signed in, no households: the same ratified climb, the
   *               labelled sky, the boxless count and the question, whose
   *               "name your own system" drawer holds the three create
   *               questions. On an empty instance the count is skipped and
   *               the card lands with the drawer already open (#1263, owner
   *               2026-10-06).
   *   onward    · a member. Home is theirs, and the door hands them on to it.
   *   invited   · #871: a reader whose FIRST look at the session follows
   *               redeeming an invitation (`isInvitedLanding`). The same
   *               climb, sky and count as newcomer — the household is real
   *               and theirs is one of the systems discovered — but at the
   *               point the question would stand there is nothing to ask:
   *               the sky moves to the household the invitation named
   *               instead, by the same road ONWARD already takes there.
   *
   * ONE FLIGHT PER ARRIVAL (#1263, ruling revised 2026-10-06). Every arrival
   * flies the climb exactly once, before anything is asked. The door is never
   * drawn again after the flight leaves it, and /home never flies a second
   * time: Create and the invited landing both go to /home WITHOUT a launch
   * marker, so home's `consumeLaunch()` is false there and it arrives the
   * ordinary way. This supersedes the create card's reclaim and second climb
   * (owner-decisions.md:684, #862 round 3) for the arrival only.
   */
  /** @typedef {import("./stage.js").VisibleHousehold} VisibleHousehold */
  /** @typedef {{ name: string, reason: string, householdId: string | null }} Rejected */

  let { data } = $props();

  /*
   * THE FIXTURE HARNESS (#451's ORBIT_FIXTURES, extended to this page for
   * #410/§15). The arrival's stages are states the fixture workspace cannot be
   * in — it has households — so the harness NAMES the stage, exactly as home's
   * `?flight=up&at=` names a beat of the flight. Inert in production: without
   * the flag the query string is not read at all.
   *
   *   ?arrival=newcomer                     the question, arrived at
   *   ?arrival=newcomer&drawer=1            the same, its create drawer open
   *   ?arrival=newcomer&drawer=1&reject=N   the one-line refusal, at rest
   *   ?arrival=newcomer&at=<ms>             one millisecond of the climb
   */
  /* $derived, not a plain const: `data` is a prop, and reading it through a
     bare const only ever captures its value at this component's first run
     (svelte-check's own state_referenced_locally). Nothing about the fixture
     flag actually changes within a mounted session in practice — it is a
     per-deployment flag read once per request (+page.server.js) — but the
     read stays live rather than silently freezing if that ever stops being
     true, which costs nothing since these are read a handful of times, all
     from inside onMount's decide(). */
  const fixture = $derived(browser && data?.fixtures ? page.url.searchParams.get("arrival") : null);
  const fixtureReject = $derived(fixture ? page.url.searchParams.get("reject") : null);
  const fixtureDrawer = $derived(fixture ? page.url.searchParams.get("drawer") === "1" : false);
  const fixtureAt = $derived(fixture && page.url.searchParams.has("at")
    ? (Number(page.url.searchParams.get("at")) || 0)
    : null);

  let stage = $state(DOOR);
  let galaxy = $state({});
  /** @type {VisibleHousehold[]} */
  let visibleHouseholds = $state([]);
  /** @type {ReturnType<typeof Flight> | null} */
  let flight = $state(null);
  let climbing = $state(false);
  let busy = $state(false);
  /** @type {Rejected | null} */
  let rejected = $state(null);
  /* #1263: the belong card's "name your own system" drawer. Open from the
     start on an empty instance, where there is nothing to ask to join. */
  let drawerOpen = $state(false);

  let name = $state("");
  let timezone = $state(preferredTimeZone(detectedZone()));
  let currency = $state(preferredCurrency(detectedCurrency()));

  /*
   * IS A LAUNCH OWED? Taken at initialisation, before anything else on this
   * page can take it: the sign-in below clears a stale marker the moment it
   * mounts (an abandoned departure must never fire later — arrival.js), and the
   * arrival's own decision comes a fetch after that, so a claim read any later
   * than here would already be gone.
   *
   * Whichever stage wins then gets it: the member's climb is re-armed for
   * /home and the newcomer's plays right here. Nothing on this page ever
   * writes a fresh one (#1263): an arrival flies once.
   */
  const launchOwed = browser && consumeLaunch();

  const body = () => document.body;
  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Set by this component's own teardown (#1151 W1-R6), the same pattern
   *  SignIn.svelte already carries for its own async checks: `decide()`'s
   *  own fetches can still be in flight once the reader has left, and
   *  resuming then would yank them on to /home from wherever they actually
   *  are now, or leave `enterNewcomer`'s launch classes on a body this
   *  component no longer owns. */
  let disposed = false;

  onMount(() => {
    /* #1222: a launch is owed, so a flight is coming whichever way the answers
       fall (the climb here, or /home's after the hand-on). Ready its world NOW,
       hurried, while the session and workspace are still being asked, instead
       of when the climb starts and has to hold for it. Gentle, as the door's
       own ask is: never under save-data, never a compile that would stop the
       page; and without the test frames, which wait until this reader is known
       to fly here (decide(), below). */
    if (launchOwed) readyFlight({ hurry: true, gentle: true, prove: false });
    decide();
    return () => {
      disposed = true;
      body().classList.remove("showform", "showdawn", "rejected",
                              "shownew", "instrument", "belong",
                              "counting", "bare", "launching", "pinned");
    };
  });

  /**
   * "Read off your browser" — the sheet's own words for both of these, and the
   * only two answers the card does not make the reader give. A zone or a
   * currency the card does not offer falls back to its first option, and both
   * move to settings afterwards.
   */
  function detectedZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return null;
    }
  }
  function detectedCurrency() {
    try {
      const region = new Intl.Locale(navigator.language).region;
      if (!region) return null;
      return (/** @type {Record<string, string>} */ ({
        GB: "GBP", IE: "EUR", FR: "EUR", DE: "EUR", US: "USD", CA: "CAD", AU: "AUD", NZ: "NZD",
      }))[region] ?? null;
    } catch {
      return null;
    }
  }

  /** Who is knocking, and what they belong to. */
  async function decide() {
    if (fixture) {
      applyFixture();
      return;
    }
    let workspace = null;
    try {
      /* Deliberately the session first and bare of the seam's own 401 journey:
         on the front door a 401 is not an error, it is the answer — this reader
         is signed out and the door is what they came for. */
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      /* #1151 W1-R6: the reader this screen was deciding for may already be
         gone — SignIn.svelte's own pattern for the same race. Past this
         point, carrying on would be deciding for whoever is on screen now,
         not this component. */
      if (disposed) return;
      if (!response.ok) return;                /* signed out: the door stands */
      /* A session pointed at a household belongs to a member, and that is the
         whole question answered — no workspace read at all on the journey
         almost every reader is making. Only a reader whose session points
         nowhere costs the fuller question. A session still pointing at a
         household its owner has since left is handed on the same way, and lands
         on home's own adrift surface, which is the honest answer there too. */
      const session = await response.json().catch(() => null);
      if (disposed) return;
      if (isInvitedLanding(session)) {
        visibleHouseholds = session.visibleHouseholds ?? [];
        galaxy = labelledSkyOf(visibleHouseholds);
        stage = INVITED;
        /* Always the full climb, `launchOwed` or not: this landing only ever
           happens the one time `isInvitedLanding` can be true at all (its own
           note), so there is no "already arrived, refresh" case for it to
           answer differently — see enterNewcomer's own note on that case. */
        await enterNewcomer(true);
        return;
      }
      if (session?.activeHouseholdId) { handOn(); return; }
      /* a session pointing nowhere flies here (the newcomer's climb, or the
         invited one): have the world's test frames run while the workspace is
         read, so the climb finds the verdict made (#1222) */
      if (launchOwed) readyFlight({ hurry: true, gentle: true });
      workspace = await readWorkspace();
      if (disposed) return;
    } catch {
      /* The server could not be reached. The door is the honest surface: it is
         the one thing on this screen that needs no answer. */
      return;
    }

    const next = arrivalStageOf(workspace);
    if (next === ONWARD) { handOn(); return; }
    if (next === ASKING) {
      /* #1151 W1-F2: a workspace that came back empty is asked, not
         answered — the same honest surface as a server that cannot be
         reached at all (the catch above). */
      return;
    }
    visibleHouseholds = workspace.visibleHouseholds ?? [];
    galaxy = labelledSkyOf(visibleHouseholds);
    drawerOpen = visibleHouseholds.length === 0;
    stage = NEWCOMER;
    await enterNewcomer(launchOwed);
  }

  /**
   * Home is theirs, so the door hands them on to it — and hands the launch on
   * with them: the climb belongs to the surface it lands on, and that surface
   * is /home's dial, not this one.
   */
  function handOn() {
    if (launchOwed) markLaunch();
    location.replace("/home");
  }

  /**
   * WHERE THE CHOOSER WOULD STAND (#871): the invited landing's own road out,
   * fired by Flight's `onbelong` at the exact beat that draws `belong` for an
   * ordinary newcomer. No new camera move, and NO launch marker (#1263): the
   * climb already flew here, so /home's `consumeLaunch()` is false and it
   * arrives the ordinary way. ADR-0012:147 is upheld. Nothing here names the
   * household — the navigation is bare, and `/home` resolves it from the
   * session the same way it always does.
   */
  function toHousehold() {
    location.assign("/home");
  }

  /** The fixture harness's own version of the same decision. */
  function applyFixture() {
    /* Only ever called from decide() after `if (fixture)`, so this can never
       actually return early -- it just gives `fixture` a non-null type for
       the lookup below. */
    if (!fixture) return;
    const workspace = ARRIVAL_FIXTURES[/** @type {keyof typeof ARRIVAL_FIXTURES} */ (fixture)];
    if (!workspace) return;
    visibleHouseholds = workspace.visibleHouseholds;
    galaxy = labelledSkyOf(workspace.visibleHouseholds);
    drawerOpen = fixtureDrawer || visibleHouseholds.length === 0;
    /*
     * The drawer is photographed, so its two "read off your browser" answers
     * are pinned to the card's own first options instead of the machine the
     * gate happens to be running on. Everything else on this surface is
     * already deterministic.
     */
    timezone = preferredTimeZone("Europe/London");
    currency = preferredCurrency("GBP");
    if (fixtureReject) {
      const clash = collidingHouseholdOf(fixtureReject, visibleHouseholds);
      name = fixtureReject;
      rejected = { name: fixtureReject, reason: "already exists here", householdId: clash?.id ?? "fixture" };
      setTimeout(() => body().classList.add("rejected"), 0);
    }
    stage = NEWCOMER;
    /* The fixture replaces the DATA, never the trigger: a fixture run with the
       one-shot marker in its tab flies the whole climb exactly as a real
       arrival does, and one without it gets the question arrived at. */
    enterNewcomer(launchOwed);
  }

  /**
   * THE NEWCOMER'S ARRIVAL. With a launch owed, the whole ratified climb plays
   * and sets down on the labelled sky. Without one — a refresh, a bookmark, a
   * Back — the reader gets the question ALREADY ARRIVED AT, which is what
   * /logout does with the goodbye and for the same reason: the staging is
   * class-driven, so the end of a journey is a set of classes.
   */
  /** @param {boolean} launch */
  async function enterNewcomer(launch) {
    if (launch || fixtureAt !== null) {
      climbing = true;
      body().classList.add("launching");
      if (!reduced()) body().classList.add("showdawn");
      await tick();
      if (disposed) return; /* #1151 W1-R6 */
      /* The labelled sky is drawn but not shown: `shownew` arrives with the
         flight's own `land` beat, so the climb is not flying over the surface
         it is about to set down on. */
      flight?.ascend(fixtureAt === null ? {} : { at: fixtureAt });
      return;
    }
    body().classList.add("shownew", "instrument", "belong");
  }

  /**
   * THE EMPTY INSTANCE SKIPS THE COUNT (#1263, owner 2026-10-06): "skip the
   * count beat: land straight on the belong card with the drawer down." There
   * is nothing to count, so the card arrives with the labelled sky's chrome
   * (Flight's `instrument` beat, its `onsettled`) rather than after the count's
   * hold; Newcomer draws no count at all for zero systems, so the flight's own
   * later `countOn`/`belong` beats find nothing left to change.
   */
  function settled() {
    if (stage === NEWCOMER && visibleHouseholds.length === 0) body().classList.add("belong");
  }

  /**
   * The north star's "create" (and any other road to the drawer) while the
   * question has not arrived yet: bring the card in now rather than open a
   * drawer nobody can see.
   */
  function toDrawer() {
    if (stage !== NEWCOMER) return;
    body().classList.remove("counting");
    body().classList.add("belong");
  }

  /* ── CREATE, FROM THE DRAWER (#1263) ────────────────────────────────────
   * The climb already flew on this document, so Create goes to /home with no
   * launch marker and no reclaim: home's `consumeLaunch()` is false, there is
   * no dawn and no second climb, and the POL-1 arrival brings the dial in with
   * the new name, the first-run tour after it as for anyone.
   */
  async function submit() {
    if (busy) return;
    const wanted = name.trim();
    if (!wanted) return;

    /* THE REFUSAL, from the server's own list. `visibleHouseholds` is every
       live system on this instance as the server sees it, so a collision here
       is a fact and the road the line offers — ask to join it — is real. */
    const clash = collidingHouseholdOf(wanted, visibleHouseholds);
    if (clash) { reject(wanted, "already exists here", clash.id); return; }

    busy = true;
    body().classList.remove("rejected");
    try {
      if (fixture) await new Promise((resolve) => setTimeout(resolve, 60));
      else await applyCommand(createSystemCommand({ name: wanted, timezone, currency }));
    } catch (error) {
      busy = false;
      /* One warm line, in the server's own words. Nothing was created, and the
         answers are visibly still in the fields, so neither is said. */
      reject(wanted, /** @type {{ message?: string }} */ (error)?.message ?? "could not be created", null);
      return;
    }
    location.assign("/home");
  }

  /**
   * @param {string} refused
   * @param {string} reason
   * @param {string | null} householdId
   */
  function reject(refused, reason, householdId) {
    rejected = { name: refused, reason, householdId };
    setTimeout(() => body().classList.add("rejected"), 30);
  }

  /* Typing disarms the rejection, because the rejection was about the NAME: a
     different word is a different answer, and nothing has seen it yet. */
  function naming() {
    if (rejected && name.trim() !== rejected.name) {
      rejected = null;
      body().classList.remove("rejected");
    }
  }

  /** The row, and the constellation behind it: POST the real join request. */
  /** @param {VisibleHousehold} row */
  async function ask(row) {
    if (!row?.id || row.requested) return;
    if (!fixture) {
      try {
        await requestToJoin(row.id);
      } catch {
        /* §11's route is idempotent and the only failures left are ones the
           reader cannot act on. The row stays as it was rather than lying. */
        return;
      }
    }
    visibleHouseholds = visibleHouseholds.map((household) =>
      household.id === row.id ? { ...household, requested: true } : household);
    galaxy = labelledSkyOf(visibleHouseholds);
  }

  const title = $derived(
    stage === NEWCOMER || stage === INVITED ? "Orbit — arrival"
      : "Orbit — sign in");
</script>

<!-- #843: one landmark and one heading for whichever stage is standing, since
     the door/newcomer stages never render at once. The visible title
     is carried entirely by the mockups' own art (the lockup, the card, the
     climb), so the heading names the stage for a reader who cannot see it,
     rather than duplicating text already on screen. -->
<!-- `past-door` (#1263): once the arrival has decided, the door's own card
     (SignIn's `.ringcard`, which a local-only instance raises from the public
     availability answer whoever is signed in) is not drawn again — the door
     is never redrawn after the flight leaves it, and that layer would
     otherwise stand over the belong card and its drawer. -->
<main class="arrival" class:past-door={stage !== DOOR}>
  <h1 class="sr-only">{title}</h1>

  <!-- THE LOGIN SCREEN IS THE BASE LAYER, exactly as the sheet builds it: the
       dawn, the lockup and (only on the door) the gate. The card and the
       newcomer's sky stand ON it, and the chrome is hidden by `showform` while
       they do — no wordmark, no glyph, no button, no footer. -->
  <SignIn gate={stage === DOOR} dawnShown={!climbing} {title} />

  {#if stage === NEWCOMER || stage === INVITED}
    <!-- #871: `showChooser` is false only for INVITED — no chooser drawn at
         any frame, not even one CSS hides, for a reader whose household is
         not theirs to pick. -->
    <!-- #1263: the create drawer lives in the belong card, and its three
         answers, its refusal and its submit stay here with the host. -->
    <Newcomer {galaxy} {visibleHouseholds} onask={ask} oncreate={toDrawer}
              showChooser={stage !== INVITED}
              bind:drawerOpen bind:name bind:timezone bind:currency {rejected} {busy}
              onsubmit={submit} onnaming={naming} />
    {#if climbing}
      <!-- The landing is the host's, as it is on home: the flight says WHEN and
           this reveals the labelled sky at that exact beat. landing="invited"
           flies the identical beats and differs only at the one the chooser
           would stand on (Flight.svelte's own note on `onbelong`). -->
      <Flight bind:this={flight} landing={stage === INVITED ? "invited" : "newcomer"}
              name="" subtitle="you are new here"
              onland={() => body().classList.add("shownew")}
              onsettled={settled}
              onbelong={stage === INVITED ? toHousehold : undefined} />
    {/if}
  {/if}
</main>
