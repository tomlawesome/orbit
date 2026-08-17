<script>
  import { onMount, tick } from "svelte";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import SignIn from "$lib/flight/SignIn.svelte";
  import Flight from "$lib/flight/Flight.svelte";
  import { consumeLaunch, markLaunch } from "$lib/flight/arrival.js";
  import { applyCommand, readWorkspace, requestToJoin } from "$lib/data/workspace.js";
  import { labelledSkyOf } from "$lib/data/chart.js";
  import { ARRIVAL_FIXTURES } from "$lib/data/fixtures/arrival.js";
  import CreateSystem from "./CreateSystem.svelte";
  import Newcomer from "./Newcomer.svelte";
  import {
    CREATE, DOOR, NEWCOMER, ONWARD,
    arrivalStageOf, collidingHouseholdOf, createSystemCommand,
    preferredCurrency, preferredTimeZone,
  } from "./stage.js";
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
   *   create    · signed in, no households, and none out there either: the
   *               first admin names the first system. The sealed card, alone on
   *               the dawn, with the login screen taken off it entirely.
   *   newcomer  · signed in, no households, on an instance that has some: the
   *               same ratified climb, the labelled sky, the boxless count and
   *               the question.
   *   onward    · a member. Home is theirs, and the door hands them on to it.
   *
   * THE TWO HONEST DEVIATIONS, both stated where they happen:
   *
   *   1. The reader reaches this surface by coming back from the identity
   *      provider, so the create card is reached AFTER authenticating — which
   *      is exactly what the fourth-pass ruling describes ("we must have
   *      already logged in to see this screen"). The login chrome is therefore
   *      GONE while the card shows, and RECLAIMED on submit. It steps aside as
   *      the card arrives rather than never having been there, because the
   *      ruling's own word for what happens on submit is that the logo and text
   *      "REAPPEAR" — which presupposes the reader saw them and they left.
   *   2. On submit, the ascent plays on /home rather than on this document.
   *      The mockup runs reclaim → climb → landing unbroken; the product's
   *      landing is a different route with the household's real data on it, so
   *      the journey is cut at the same joint the login journey is already cut
   *      at — after the hand-over beat, before the climb — and the climb then
   *      plays whole, all 4.8 seconds of it plus the dwell and the instrument,
   *      over the populated home. Nothing in the flight changes; a one-shot
   *      marker carries the "a launch is owed" claim across (arrival.js).
   */
  let { data } = $props();

  /*
   * THE FIXTURE HARNESS (#451's ORBIT_FIXTURES, extended to this page for
   * #410/§15). The arrival's stages are states the fixture workspace cannot be
   * in — it has households — so the harness NAMES the stage, exactly as home's
   * `?flight=up&at=` names a beat of the flight. Inert in production: without
   * the flag the query string is not read at all.
   *
   *   ?arrival=create              the card, at rest
   *   ?arrival=create&reject=NAME  the sealed one-line refusal, at rest
   *   ?arrival=create&handover=1   the reclaim held: the lockup back, the card
   *                                gone — the frame the flight lifts from
   *   ?arrival=newcomer            the question, arrived at
   *   ?arrival=newcomer&at=<ms>    one millisecond of the newcomer's climb
   */
  const fixture = browser && data?.fixtures ? page.url.searchParams.get("arrival") : null;
  const fixtureReject = fixture ? page.url.searchParams.get("reject") : null;
  const fixtureHandover = fixture ? page.url.searchParams.get("handover") === "1" : false;
  const fixtureAt = fixture && page.url.searchParams.has("at")
    ? (Number(page.url.searchParams.get("at")) || 0)
    : null;

  let stage = $state(DOOR);
  let galaxy = $state({});
  let visibleHouseholds = $state([]);
  let flight = $state(null);
  let climbing = $state(false);
  let busy = $state(false);
  let rejected = $state(null);

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
   * /home, the newcomer's plays right here, and the create card writes a fresh
   * one on submit. The marker is a claim being carried, not a flag being read.
   */
  const launchOwed = browser && consumeLaunch();

  const body = () => document.body;
  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  onMount(() => {
    decide();
    return () => {
      body().classList.remove("showform", "showdawn", "reclaimed", "rejected",
                              "grounded", "shownew", "instrument", "belong",
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
      return { GB: "GBP", IE: "EUR", FR: "EUR", DE: "EUR", US: "USD", CA: "CAD", AU: "AUD", NZ: "NZD" }[region] ?? null;
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
      if (!response.ok) return;                /* signed out: the door stands */
      /* A session pointed at a household belongs to a member, and that is the
         whole question answered — no workspace read at all on the journey
         almost every reader is making. Only a reader whose session points
         nowhere costs the fuller question. A session still pointing at a
         household its owner has since left is handed on the same way, and lands
         on home's own adrift surface, which is the honest answer there too. */
      const session = await response.json().catch(() => null);
      if (session?.activeHouseholdId) { handOn(); return; }
      workspace = await readWorkspace();
    } catch {
      /* The server could not be reached. The door is the honest surface: it is
         the one thing on this screen that needs no answer. */
      return;
    }

    const next = arrivalStageOf(workspace);
    if (next === ONWARD) { handOn(); return; }
    visibleHouseholds = workspace.visibleHouseholds ?? [];
    galaxy = labelledSkyOf(visibleHouseholds);
    if (next === CREATE) { enterCreate(); return; }
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

  /** The fixture harness's own version of the same decision. */
  function applyFixture() {
    const workspace = ARRIVAL_FIXTURES[fixture];
    if (!workspace) return;
    visibleHouseholds = workspace.visibleHouseholds;
    galaxy = labelledSkyOf(workspace.visibleHouseholds);
    if (arrivalStageOf(workspace) === CREATE) {
      /*
       * The card is photographed, so its two "read off your browser" answers
       * are pinned to the mockup's own first options instead of the machine
       * the gate happens to be running on. Everything else on this surface is
       * already deterministic.
       */
      timezone = preferredTimeZone("Europe/London");
      currency = preferredCurrency("GBP");
      if (fixtureReject) {
        name = fixtureReject;
        rejected = { name: fixtureReject, reason: "already exists here", householdId: "fixture" };
        setTimeout(() => body().classList.add("rejected"), 0);
      }
      if (fixtureHandover) {
        name = name || "Lawson Home";
        body().classList.add("pinned", "reclaimed");
      }
      enterCreate();
      return;
    }
    stage = NEWCOMER;
    /* The fixture replaces the DATA, never the trigger: a fixture run with the
       one-shot marker in its tab flies the whole climb exactly as a real
       arrival does, and one without it gets the question arrived at. */
    enterNewcomer(launchOwed);
  }

  /** The card takes the screen, and the login chrome steps aside for it. */
  function enterCreate() {
    body().classList.add("showform");
    stage = CREATE;
  }

  /**
   * THE NEWCOMER'S ARRIVAL. With a launch owed, the whole ratified climb plays
   * and sets down on the labelled sky. Without one — a refresh, a bookmark, a
   * Back — the reader gets the question ALREADY ARRIVED AT, which is what
   * /logout does with the goodbye and for the same reason: the staging is
   * class-driven, so the end of a journey is a set of classes.
   */
  async function enterNewcomer(launch) {
    if (launch || fixtureAt !== null) {
      climbing = true;
      body().classList.add("launching");
      if (!reduced()) body().classList.add("showdawn");
      await tick();
      /* The labelled sky is drawn but not shown: `shownew` arrives with the
         flight's own `land` beat, so the climb is not flying over the surface
         it is about to set down on. */
      flight?.ascend(fixtureAt === null ? {} : { at: fixtureAt });
      return;
    }
    body().classList.add("shownew", "instrument", "belong");
  }

  /* ── THE CREATE PATH'S LAUNCH ────────────────────────────────────────────
   * §15, fourth pass, owner verbatim: "the orbit logo and text reappear and we
   * run the login intro, the only tweak being this time there's no login
   * button as we already passed it, otherwise exactly the same."
   *
   * So on success the lockup is RECLAIMED over 620ms — the wordmark and glyph
   * fade back onto the sky (0.5s) while the card dissolves off it (0.6s), both
   * finished before anything else happens, so the frame the flight lifts from
   * IS the ratified login screen with the button absent. Then the climb, whole
   * and unaltered, on the landing it belongs to.
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
      reject(wanted, error?.message ?? "could not be created", null);
      return;
    }
    /* A launch is owed on the landing, whether or not one was owed here. */
    markLaunch();
    body().classList.add("reclaimed");
    setTimeout(() => location.assign("/home"), reduced() ? 200 : 620);
  }

  /**
   * The rejection keeps the reader grounded: the climb starts, catches, and
   * sets back down (the mockup's own `settleback`, 950ms).
   */
  function reject(refused, reason, householdId) {
    rejected = { name: refused, reason, householdId };
    setTimeout(() => body().classList.add("rejected", "grounded"), 30);
    setTimeout(() => body().classList.remove("grounded"), 950);
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

  /**
   * "or name your own system →" — the newcomer's other road, and the same three
   * questions (the sealed sheet: the card is the admin's card). The labelled
   * sky steps aside for it, and the collision check still holds: the name they
   * choose cannot be one of the systems they were just offered.
   */
  function toCreate() {
    flight?.reset();
    climbing = false;
    body().classList.remove("shownew", "instrument", "belong", "counting", "bare", "launching");
    enterCreate();
  }

  /**
   * The refusal's own road out. The sheet's link goes to the newcomer's
   * arrival, and that is where this goes: the question, with the system that
   * holds the name among the rows waiting to be pressed. The request itself is
   * NOT filed on the reader's behalf — asking to join is theirs to do.
   */
  async function askFromCard() {
    body().classList.remove("showform", "rejected");
    rejected = null;
    stage = NEWCOMER;
    await enterNewcomer(false);
  }

  const title = $derived(
    stage === CREATE ? "Orbit — name your first system"
      : stage === NEWCOMER ? "Orbit — where do you belong?"
      : "Orbit — sign in");
</script>

<!-- THE LOGIN SCREEN IS THE BASE LAYER, exactly as the sheet builds it: the
     dawn, the lockup and (only on the door) the gate. The card and the
     newcomer's sky stand ON it, and the chrome is hidden by `showform` while
     they do — no wordmark, no glyph, no button, no footer. -->
<SignIn gate={stage === DOOR} dawnShown={!climbing} {title} />

{#if stage === CREATE}
  <CreateSystem bind:name bind:timezone bind:currency {rejected} {busy}
                onsubmit={submit} onnaming={naming} onask={askFromCard} />
{/if}

{#if stage === NEWCOMER}
  <Newcomer {galaxy} {visibleHouseholds} onask={ask} oncreate={toCreate} />
  {#if climbing}
    <!-- The landing is the host's, as it is on home: the flight says WHEN and
         this reveals the labelled sky at that exact beat. -->
    <Flight bind:this={flight} landing="newcomer" name="" subtitle="you are new here"
            onland={() => body().classList.add("shownew")} />
  {/if}
{/if}
