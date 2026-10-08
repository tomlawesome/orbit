<script>
  import { onMount, tick } from "svelte";
  import { browser } from "$app/environment";
  import { afterNavigate, beforeNavigate, goto, pushState, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { mountAccount, mountEmptySky, mountHome } from "./home.behaviour.js";
  import Leave from "$lib/flight/Leave.svelte";
  import { readyFlightAtLeisure } from "$lib/flight/warm.js";
  import Sun from "$lib/sun/Sun.svelte";
  import { SUN_R } from "$lib/sun/furnace.js";
  import { othersOf } from "$lib/flight/engine.js";
  import Dawn from "$lib/flight/Dawn.svelte";
  import { consumeLaunch } from "$lib/flight/arrival.js";
  /* The sun is one of the household screen's two doors, and that screen owns
     the marker both doors speak through (§15, owner 2026-08-17). */
  import { markDoor } from "../household/[id]/door.js";
  import { WorkspaceError, applyCommand, approveReceipt, dueDateIn, attachItemDocument, dismissReceipt, readHome, readItem, readItemDocuments, removeDocument, requestToJoin, restoreDocument, signOut } from "$lib/data/workspace.js";
  import { archiveCommand, completeCommand, snoozeCommand, upsertCommand } from "$lib/data/commands.js";
  import { createHeldCompletion } from "$lib/data/held-completion.js";
  import { createArm } from "$lib/pocket/arm.js";
  import { corridorOf, dialBodiesOf, manifestGroupsOf } from "$lib/data/chart.js";
  import { ago, agoLong, longDate, money } from "$lib/format.js";
  import { showUrgentCount } from "$lib/urgent-badge.js";
  import Pocket from "./pocket.svelte";
  import { readSearchDocuments, searchPocket } from "./pocket-search.js";
  import { SvelteMap } from "svelte/reactivity";
  import { tlabel } from "./bands.js";
  import { AXIS_X0, AXIS_X1, AXIS_Y, assignTiers, leaderPathOf, monthTicks, stripActsOf, TIER_RUN_Y, textWidth, UNSCHEDULED_X, xOfDays } from "./strip-layout.js";
  import CorridorRow from "./CorridorRow.svelte";
  import PreviewCard from "$lib/reading/PreviewCard.svelte";
  import ChooserCard from "$lib/editing/ChooserCard.svelte";
  import { DrawerModes, pressKeepsChooser } from "./drawer-modes.svelte.js";
  import { amendedOf, proposedItemOf } from "$lib/editing/item-draft.js";
  import { WIDE_QUERY, cardWidthOf, pairOf, trackOf } from "./preview-pair.js";
  import { WAKE_HOLD_MS, wake } from "$lib/pocket/wake.js";
  import { shortDate } from "$lib/data/belt.js";
  import NorthStarMark from "$lib/NorthStarMark.svelte";
  import { watchTour } from "$lib/tour/watch.js";
  import "./home.css";

  /**
   * The home screen. Built from design/v19/home.html (issue #399) and owned
   * here from that point on.
   *
   * Svelte renders the markup and then stands back: mountHome() takes the
   * document and runs the chart, the galaxy and the drawers as the imperative
   * DOM code they were written as. See home.behaviour.js for why.
   *
   * Two dialects share this route (CON-10, #430): the desk chart below and the
   * pocket in pocket.svelte. Both are server-rendered and CSS chooses between
   * them, so there is no flash of the wrong one and no-JS still gets a page.
   * Only the visible dialect is mounted, because each binds window-level
   * listeners and the hidden one would be handling events against elements
   * with no layout.
   */
  const DESK = "(min-width: 901px)";

  /* Declared before `view` because `view` starts from it; the launch below is
     what the rest of this prop is for. */
  let { data } = $props();

  /** @typedef {import('$lib/data/workspace.js').HomeView} HomeView */
  /* Straight from the server's read (#842), so the FIRST render already has
     the manifest, the dial and the corridor — a reader with no JavaScript gets
     a page rather than an empty one. Null only when that read failed; onMount
     reads again either way and replaces this with a live view. */
  /** @type {HomeView | null} */
  // svelte-ignore state_referenced_locally
  let view = $state(data?.view ?? null);
  /** The onMount re-read's own failure (#1151 W1-R4): null while that read
      has not failed, or has not been tried yet. */
  /** @type {string | null} */
  let homeLoadProblem = $state(null);
  /* The system-status drawer's real data (#863), read server-side alongside
     `view` (see +page.server.js). Null only when that read failed; the
     drawer then shows no service rows rather than the fake, always-degraded
     markup it used to carry. */
  /** @type {import('orbit/server/system-status').SystemStatus | null} */
  // svelte-ignore state_referenced_locally
  let systemStatus = $state(data?.systemStatus ?? null);
  /* The handle's colour is CSS, keyed off this body class exactly as the
     mockup's own demo toggle was (design/v19/home.html) -- only now driven by
     the real word instead of a fixed one. Effect, not onMount: it has to
     react to a later `systemStatus` (a retry after a failed first read), and
     its own cleanup is what stops a stale colour riding to the next screen. */
  $effect(() => {
    document.body.classList.toggle("health-degraded", systemStatus?.handle === "degraded");
    return () => document.body.classList.remove("health-degraded");
  });
  /** Every word the drawer draws maps to one of three dot colours; anything unrecognised reads as unknown, not healthy. */
  /** @type {Record<string, string>} */
  const STATUS_DOT = {
    healthy: "var(--ok)", ready: "var(--ok)", maintenance: "var(--ok)",
    unreachable: "var(--degraded)", failed: "var(--degraded)", degraded: "var(--degraded)",
    starting: "var(--ink-faint)", not_enabled: "var(--ink-faint)", disabled: "var(--ink-faint)",
  };
  /** @param {string} word */
  const statusDot = (word) => STATUS_DOT[word] ?? "var(--ink-faint)";
  /** @param {string} word */
  const statusWord = (word) => (word === "not_enabled" ? "not enabled" : word);
  /** @param {{observedAt?: string}} row */
  const observedLabel = (row) => (row.observedAt ? ago(row.observedAt, view?.now ?? new Date().toISOString()) : null);
  /* Some of the $derived expressions below build a value from `view` inside a
     single ternary, and svelte-check's control-flow narrowing does not carry
     the `view ? ... : ...` guard through into the branch in that position —
     the branch still type-checks as if `view` were null. This cast is the
     type-only way to tell it what the guard already guarantees at runtime;
     it does nothing at runtime beyond returning its argument. */
  /** @type {(v: HomeView | null) => HomeView} */
  const asView = (v) => /** @type {HomeView} */ (v);

  /*
   * Coming BACK to home is not arriving at it (owner, 2026-08-15: leaving an
   * item must return you to exactly where you were). The POL-1 fanfare plays
   * only on a forward arrival — the CSS keys off .arrive — and a history
   * return restores the scroll position once the data has given the page its
   * height (SvelteKit's own restoration fires before the fetch resolves, so
   * it lands at the top without this).
   */
  /* ---- THE LAUNCH LANDS HERE (#410, §15) --------------------------------
   *
   * The owner ratified the login flight verbatim and ruled it ships as THE
   * login for every user, every time. The climb cannot play from the button —
   * that press leaves Orbit for the identity provider — so it plays HERE, on
   * the authenticated return, whole and unaltered, and home settles out of
   * its light: the bare sky first (planets, sun, the household's name), three
   * seconds of it, and only then the instrument.
   *
   * Decided during initialisation rather than in onMount, and the body class
   * with it, so the dawn is already over home in the first painted frame
   * instead of home flashing behind it. consumeLaunch() takes the marker away
   * as it reads it: an ordinary navigation, a refresh, a Back or a second tab
   * never flies. See $lib/flight/arrival.js.
   */
  /* The fixture harness (see +page.server.js): drives either journey to one
     millisecond and holds it there. Off unless the server says ORBIT_FIXTURES,
     so the query string is inert in the product. Reading `data` here once,
     deliberately: the flight it drives is decided at load and held there
     (see the launch note below), never recomputed off a later `data`. */
  // svelte-ignore state_referenced_locally
  const fixtureFlight = browser && data?.fixtures ? page.url.searchParams.get("flight") : null;
  const fixtureAt = Number(page.url.searchParams.get("at") ?? 0) || 0;

  const launching = browser && (consumeLaunch() || fixtureFlight === "up");
  if (launching) {
    document.body.classList.add("launching");
    /* Reduced motion keeps every state change and drops the flight, so it
       never puts the dawn up — there would be nothing to take it away. */
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.body.classList.add("showdawn");
    }
  }
  onMount(() => {
    /* A real launch starts the moment the document does — the reader is
       coming back from the identity provider and the dawn must already be
       over home. A fixture waits for the household to arrive first, so the
       beats after the landing have a dial to land on. */
    if (launching && !fixtureFlight) leave?.ascend();
  });

  /* ---- A REFUSED SIGN-IN, SAID ONCE (#1033, ADR-0027 consequences) -------
   * Somebody pressed "This wasn't me" on an approval mail, so nobody got in
   * — and somebody knew this account's password. The sky is where that is
   * said, because it is the first thing the account holder sees after the
   * sign-in that DID work, and it is said in one line with the one action
   * that answers it: change the password.
   *
   * Asking takes it, so it appears once and does not follow the reader
   * around; never asked under fixtures, because a refusal is a real event on
   * a real account and the fidelity gate must not photograph one.
   */
  /** @type {string | null} */
  let refusedAt = $state(null);
  onMount(async () => {
    if (data?.fixtures) return;
    try {
      const response = await fetch("/api/auth/sign-in-notice", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      refusedAt = (await response.json())?.notice?.deniedAt ?? null;
    } catch {
      /* A notice that cannot be read is a notice not shown. It is still
         unstamped, so the next load says it instead — which is the right way
         round for something worth saying at all. */
      refusedAt = null;
    }
  });
  async function driveFixture() {
    if (!fixtureFlight) return;
    await tick();
    if (fixtureFlight === "up") leave?.ascend({ at: fixtureAt });
    else if (fixtureFlight === "down") {
      /* the descent leaves from a settled arrival, so it starts from one */
      document.body.classList.add("instrument");
      await tick();
      leave?.descend({ at: fixtureAt });
    }
  }

  /* POL-1's own fanfare would fight the landing for the dial: on a launch the
     flight owns the arrival, and this is its opening beat, not a second one. */
  let arrive = $state(!launching);
  /** @type {number | null} the scroll position a drawer asked us to put back */
  let restoreScroll = null;
  afterNavigate((navigation) => {
    if (launching) return;
    arrive = navigation.type !== "popstate";
  });

  /* ---- AND THE DESCENT LEAVES FROM HERE ---------------------------------
   * The logout is the login played backwards (§15 second pass, ruling 1), so
   * it starts on the surface the login landed on: the instrument withdraws
   * because it arrived last, the bodies disperse, the bloom is read
   * backwards, the name is written on the void with "signing out" under it,
   * and the mark sets down on the dusk's own lockup.
   */
  /* The descent, its dusk and the farewell are $lib/flight/Leave.svelte,
     shared with every other page's menu (#1253). */
  /** @type {import('$lib/flight/Leave.svelte').default | null} */
  let leave = $state(null);
  /** Set for the span of the actual signOut() request (#1151 W1-R7), so a
      second press while it is still in flight never fires a second,
      concurrent signOut() call. */
  let signingOut = $state(false);
  /** @type {string | null} */
  let signOutProblem = $state(null);

  const readyDescent = () => leave?.ready();

  /* #1299: the descent never waits for its world, so it is readied well before
     the sign-out, a few seconds after home has arrived and its painted
     animations are done, as orbit-site does on any page but the door. The
     climb (a launch) readies its own world as it starts. */
  onMount(() => (launching ? undefined : readyFlightAtLeisure()));

  async function tapSignOut() {
    /* One press (owner, 2026-10-06): the plain sign-out does not arm first. */
    if (signingOut) return;
    signingOut = true;
    signOutProblem = null;
    /*
     * THE REVOCATION BEAT, chosen deliberately: BEFORE the first frame.
     * POST /api/auth/logout deletes the session row and clears the cookie, and
     * only when the server has said so does the descent begin. A crash, a
     * closed lid or a killed tab at any point in the next six seconds can
     * therefore never leave a live session behind — the flight is a farewell
     * to something already ended, not the act of ending it.
     */
    let redirectTo = null;
    try {
      redirectTo = await signOut();
    } catch (error) {
      signingOut = false;
      signOutProblem = /** @type {any} */ (error)?.message ?? "still signed in — try again";
      return;
    }
    /* #1262: the menu goes as the descent begins, never left open over it
       (it stands above the flight's canvas). Closed the way "watch the
       tour" closes it; kept open on a refusal above, so its line is read. */
    closeAccount();
    await leave?.descendFrom(redirectTo);
  }
  /* The account card closes the way home.behaviour.js's closeOverlays
     closes it. */
  function closeAccount() {
    document.getElementById("account")?.classList.remove("open");
    document.querySelector("button.orb")?.setAttribute("aria-expanded", "false");
  }
  export const snapshot = {
    capture: () => window.scrollY,
    restore: (y) => { restoreScroll = y; },
  };

  /* Mail-in review on the row (#434): first tap arms, second fires. One
     operation id per receipt across every retry — approval is idempotent by
     construction, so a double-tap can never create two items. */
  /** @type {{ id: string | null, act: "approve" | "dismiss" | null }} */
  let armed = $state({ id: null, act: null });
  /** @type {string | null} */
  let busyReceipt = $state(null);
  /** @type {string | null} */
  let mailProblem = $state(null);

  /* §11 (#453): the ask prompt — the label is the whole surface, the
     question is the whole dialogue. Idempotent server-side. */
  /** @type {{ id: string, name: string } | null} */
  let askTarget = $state(null);
  let askBusy = $state(false);
  /** @type {string | null} */
  let askProblem = $state(null);
  let resync = () => {};
  async function ask() {
    askBusy = true;
    askProblem = null;
    try {
      await requestToJoin(/** @type {{ id: string, name: string }} */ (askTarget).id);
      askTarget = null;
      view = await readHome();
      await tick();
      resync();
    } catch (error) {
      askProblem = /** @type {any} */ (error)?.message ?? String(error);
    } finally {
      askBusy = false;
    }
  }
  /* ---- THE ROW IS THE ITEM (#424, owner ruling 2026-08-16) ---------------
   *
   * A manifest row expands IN PLACE to everything Orbit holds about the item.
   * No page navigation: the row IS the destination, which is what CON-5 meant
   * by the manifest entry being where a dial body carries you.
   *
   * THE ADDRESS. The expanded row is directly addressable, and the browser
   * bar updates QUIETLY as it opens — the URL is never printed in the
   * interface, only offered by the copy-link button on the open row. The
   * address is `/home?item=<id>`, and opening it directly loads home with
   * that row scrolled to and expanded, which is the ruling's own test of the
   * address. (`/item/<id>` remains the item's full-command surface, #455; the
   * open row links to it quietly. Whether the two addresses should become one
   * is the open question in the report — the row's read view is what the
   * owner ratified, and the commands have never been designed into it.)
   *
   * THE BACK BUTTON. Opening a row PUSHES, so Back closes it and lands you
   * exactly where you were reading. Swapping straight from one open row to
   * another REPLACES, so Back is never a tour of rows you have already read.
   * Arriving on the address directly pushes nothing, so Back still leaves the
   * way you came. SvelteKit's shallow routing carries the state, so a Back or
   * Forward restores the right row with no reload and no arrival fanfare.
   *
   * THE SCROLL. §14 sends every DRAWER home on any scroll movement. This is
   * not a drawer: it is the row, grown. A full record that vanished the
   * moment you scrolled to read the end of it would be maddening, so the
   * expanded row survives scrolling and closes only on Back, Escape, a click
   * outside it, or a second click on its own row. Noted for ratification.
   */
  /** @type {(id: string) => string} */
  const addressOf = (id) => `/home?item=${encodeURIComponent(id)}`;
  const expanded = $derived(/** @type {any} */ (page.state).orbitItem ?? null);
  /* True only while the open row owns a history entry we pushed ourselves —
     the difference between closing by going back and closing by rewriting the
     address of a deep link. */
  let pushedEntry = false;
  /** @type {import('$lib/data/workspace.js').ItemView | null} */
  let detail = $state(null);
  let detailBusy = $state(false);
  /** @type {string | null} */
  let detailProblem = $state(null);
  let copied = $state(false);
  /** @type {string | null} */
  let detailFor = null;
  /** @type {string | null} */
  let revealTarget = null;

  $effect(() => {
    const id = expanded;
    if (!id) {
      pushedEntry = false;
      detailFor = null;
      detail = null;
      detailProblem = null;
      previewDoc = null;
      modes.end();
      return;
    }
    if (detailFor === id) return;
    previewDoc = null;
    modes.end();
    footProblem = null;
    /* Everything Orbit holds, read through the same seam the item view reads
       (#446) — documents included, so "everything" is not a euphemism. */
    detailFor = id;
    detail = null;
    detailProblem = null;
    copied = false;
    detailBusy = true;
    readItem(id)
      .then(async (found) => {
        if (detailFor !== id) return;
        if (!found) detailProblem = "Orbit no longer holds this item.";
        detail = found;
        if (docsTarget === id) {
          revealTarget = null;
          await tick();
          document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "auto" });
          await focusFirstDocument(id);
          return;
        }
        /* A row opened FROM the address is put on screen twice: once as soon
           as it opens, and again once the detail has given it its full height
           — otherwise the record you asked for settles half off the bottom. */
        if (revealTarget !== id) return;
        revealTarget = null;
        await tick();
        document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "auto" });
      })
      .catch((error) => {
        if (detailFor === id) detailProblem = /** @type {any} */ (error)?.message ?? String(error);
      })
      .finally(() => {
        if (detailFor === id) detailBusy = false;
      });
  });

  /** Reads the open row's record again after something changed it from the
      drawer (#1319): a paper attached, removed or restored, a snooze. */
  async function rereadDetail() {
    const id = detailFor;
    if (!id) return;
    try {
      const found = await readItem(id);
      if (detailFor === id && found) detail = found;
    } catch (error) {
      if (detailFor === id) detailProblem = /** @type {any} */ (error)?.message ?? String(error);
    }
  }

  /* ---- #1319: a document's preview, from the open drawer -----------------
     design/v19/belt-purpose/round-3/f-preview-beside-tracked.html (F),
     owner-decisions §34. A row in the drawer's documents opens the preview
     card (PreviewCard.svelte): on a wide screen beside the drawer, its top
     level with the item card's, riding the page with it and sticky beside a
     card taller than the window; under 1200px the phone's bottom sheet. A
     press anywhere off it, or Escape, removes it at once and leaves the
     drawer open: that press is swallowed by the drawer once. */
  /** @type {import('$lib/data/workspace.js').DrawerDocument | null} */
  let previewDoc = $state(null);
  /** The document row that opened the card, for focus to return to. @type {HTMLElement | null} */
  let previewFrom = null;
  /* A press that only closed the card must not also close the drawer. Every
     press starts with it down (the capture listener below), so it swallows
     one click, never a later one. */
  let swallowClick = false;
  /** @type {HTMLElement | undefined} */
  let manifestEl = $state();
  /** @type {HTMLElement | undefined} */
  let trackEl = $state();
  let track = $state({ top: 0, height: 0 });
  let readw = $state(480);
  /** @type {{ maxWidth: number, shift: number } | null} */
  let pair = $state(null);

  /** @param {import('$lib/data/workspace.js').DrawerDocument} doc @param {HTMLElement} from */
  function openDoc(doc, from) {
    /* one card beside at a time: a document's preview puts a chooser away */
    modes.closeChooser(false);
    previewFrom = from;
    if (previewDoc?.id !== doc.id) previewDoc = doc;
  }
  /** @param {{ refocus: boolean, press: boolean }} how */
  function closeDoc({ refocus, press }) {
    previewDoc = null;
    if (press) swallowClick = true;
    if (refocus && previewFrom?.isConnected) previewFrom.focus({ preventScroll: true });
  }
  /* The reader's remove (#1054): the paper goes, the card and the reader
     close onto the drawer, and the wake offers it back. */
  /** @param {import('$lib/data/belt.js').BeltDocumentRow} doc */
  async function removeDoc(doc) {
    await removeDocument(doc.id);
    previewDoc = null;
    await rereadDetail();
    wake(`${doc.name} removed`, {
      undo: () => { restoreDocument(doc.id).then(rereadDetail).catch(() => {}); },
    });
  }
  /** @param {import('$lib/data/belt.js').BeltDocumentRow} doc */
  async function restoreDoc(doc) {
    await restoreDocument(doc.id);
    previewDoc = null;
    await rereadDetail();
  }

  /* The column beside the open drawer, and the pair centred together, kept
     in step with the drawer's height and the window (preview-pair.js). */
  $effect(() => {
    const id = expanded;
    /* the preview, or the chooser card: whichever stands beside (#1319) */
    const paper = previewDoc ?? chooserAsk;
    const manifest = manifestEl;
    if (!id || !paper || !manifest) { pair = null; return; }
    const media = matchMedia(WIDE_QUERY);
    const measure = () => {
      readw = cardWidthOf(window.innerHeight);
      const row = document.getElementById(id);
      const view = document.getElementById(`${id}-view`);
      if (!media.matches || !row || !view) { pair = null; return; }
      let rowTop = 0;
      for (let el = /** @type {HTMLElement | null} */ (row); el && el !== manifest;
        el = /** @type {HTMLElement | null} */ (el.offsetParent)) rowTop += el.offsetTop;
      track = trackOf({ rowTop, rowOffsetTop: row.offsetTop, viewOffsetTop: view.offsetTop, viewHeight: view.offsetHeight });
      const host = /** @type {HTMLElement} */ (manifest.parentElement);
      const hs = getComputedStyle(host);
      const box = host.getBoundingClientRect();
      const padL = parseFloat(hs.paddingLeft) || 0;
      const padR = parseFloat(hs.paddingRight) || 0;
      pair = pairOf({
        viewportWidth: document.documentElement.clientWidth,
        hostLeft: box.left + padL,
        hostWidth: box.width - padL - padR,
        /* the width the card settled on once its page landed, else the
           A4 width it opens at */
        cardWidth: trackEl?.offsetWidth || readw,
      });
    };
    const watch = new ResizeObserver(() => measure());
    tick().then(() => {
      measure();
      const row = document.getElementById(id);
      const view = document.getElementById(`${id}-view`);
      if (row) watch.observe(row);
      if (view) watch.observe(view);
      if (trackEl) watch.observe(trackEl);
    });
    window.addEventListener("resize", measure);
    media.addEventListener("change", measure);
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", measure);
      media.removeEventListener("change", measure);
    };
  });
  $effect(() => {
    const down = () => { swallowClick = false; };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  });

  /**
   * @param {MouseEvent} event
   * @param {string} id
   */
  function onRowClick(event, id) {
    /* A modified or middle click still means "somewhere else, please" — the
       href is a real address and the browser may have it. */
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (expanded === id) return collapseRow();
    if (expanded === null) {
      pushedEntry = true;
      pushState(resolve(`/home?item=${encodeURIComponent(id)}`), { orbitItem: id });
    } else {
      replaceState(resolve(`/home?item=${encodeURIComponent(id)}`), { orbitItem: id });
    }
  }

  function collapseRow() {
    if (expanded === null) return;
    if (pushedEntry) {
      pushedEntry = false;
      history.back();
    } else {
      replaceState(resolve("/home"), {});
    }
  }

  /**
   * A search result opens the same way a clicked row does (#424), plus a
   * reveal: the row is very likely off-screen, unlike a row the reader was
   * already looking at, so it rides the same `revealTarget` scroll the
   * address bar's own arrival uses.
   * @param {string} id
   */
  function openSearchResult(id) {
    stripOpen = false;
    if (expanded === id) return;
    revealTarget = id;
    if (expanded === null) {
      pushedEntry = true;
      pushState(resolve(`/home?item=${encodeURIComponent(id)}`), { orbitItem: id });
    } else {
      replaceState(resolve(`/home?item=${encodeURIComponent(id)}`), { orbitItem: id });
    }
  }

  /* #1305: the dial callout's documents chip opens the item's drawer with
     its documents -- the real ones, read with the record -- in place of the
     old documents dialog, which showed the mockup's two made-up papers under
     any item's name. Once the record lands, the first document row is
     brought into view and focused. */
  /** @type {string | null} */
  let docsTarget = null;
  /** @param {string} id */
  function openItemDocuments(id) {
    docsTarget = id;
    if (expanded === id && detail) { focusFirstDocument(id); return; }
    openSearchResult(id);
  }
  /** @param {string} id */
  async function focusFirstDocument(id) {
    if (docsTarget !== id) return;
    docsTarget = null;
    await tick();
    const first = /** @type {HTMLElement | null} */ (
      document.getElementById(`${id}-view`)?.querySelector("[data-doc-row]") ?? null);
    if (!first) return;
    first.scrollIntoView({ block: "nearest", behavior: "auto" });
    first.focus({ preventScroll: true });
  }

  /** @returns {Promise<boolean>} whether the address reached the clipboard */
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(new URL(addressOf(expanded), location.origin).href);
      copied = true;
    } catch {
      /* A refused clipboard is not an error worth a dialogue: the address is
         already in the browser's own bar, which is where it lives. */
      copied = false;
    }
    return copied;
  }

  /* ---- #1319: THE DRAWER'S FOOT ROW (FootRow.svelte) ----------------------
     Every act the belt had, from the open drawer, through the belt's own
     commands (commands.js): snooze, complete, attach a document, retire, and
     copy link. Since stage 2, complete asks for its date, cost and notes in
     the rows and records them at once (recordCompletion, below); `held`
     still sends what an earlier visit held and never saw confirmed
     (held-completion.js). */
  /** @type {"snooze" | "complete" | "attach" | "retire" | null} */
  let footBusy = $state(null);
  /** @type {string | null} */
  let footProblem = $state(null);
  /** The open item as a command addresses it. @returns {any} */
  const commandItem = () => (detail?.householdId && !detail.suggestion ? detail : null);
  async function rereadAll() {
    view = await readHome();
    await rereadDetail();
  }
  const held = createHeldCompletion({
    apply: applyCommand,
    holdMs: WAKE_HOLD_MS,
    onsent: () => rereadAll().catch(() => {}),
    onfailed: (error) => {
      wake(/** @type {{ message?: string }} */ (error)?.message ?? "couldn't complete it — try again", { failure: true });
    },
  });
  beforeNavigate(() => { held.flush(); });
  $effect(() => {
    const flush = () => held.flush();
    addEventListener("pagehide", flush);
    return () => removeEventListener("pagehide", flush);
  });
  /* A completion a previous visit held and never saw confirmed (#1151
     W1-S3). The pocket picks it up itself when it is the dialect showing. */
  onMount(() => {
    if (!matchMedia(DESK).matches) return;
    held.retryStashed((error) => error instanceof WorkspaceError && error.code === "version_conflict");
  });

  /**
   * One act that changes the item and then reads it again.
   * @param {"snooze" | "retire"} kind
   * @param {() => object} build
   * @param {string} words  what the wake says once it has landed
   * @param {{ leave?: boolean }} [options]  the item leaves the manifest: put the drawer away
   */
  async function runFoot(kind, build, words, { leave = false } = {}) {
    if (footBusy) return;
    footBusy = kind;
    footProblem = null;
    try {
      await applyCommand(build());
      if (leave) collapseRow();
      view = await readHome();
      if (!leave) await rereadDetail();
      wake(words);
    } catch (error) {
      footProblem = /** @type {{ message?: string }} */ (error)?.message ?? `couldn't ${kind} it — try again`;
    } finally {
      footBusy = null;
    }
  }

  /* ---- #1319 stage 2: EDITING IN THE ROWS, AND THE CHOOSER BESIDE --------
     design/v19/belt-purpose/round-8/m-colour-per-option.html (approved
     2026-10-08). The pencil puts the drawer's own rows into edit mode; due
     date, section, type and orbital period open the chooser card beside the
     drawer, in the preview's column (one card beside at a time), or as the
     bottom sheet under 1200px. Snooze opens the same calendar ("snooze
     until"); complete asks for its date, cost and notes in the rows
     (owner, 2026-10-08). Escape takes the chooser, then the edit. */
  const modes = new DrawerModes({
    save: async (item, edits) => {
      if (item.status === "suggested") { await addSuggestion(item, edits); return; }
      await applyCommand(upsertCommand(item, edits));
      await rereadAll();
    },
    onchoose: () => { previewDoc = null; },
  });
  /** The open item's household's sections, for the section's name, colour and tiles.
      A suggestion not yet given a household files into the account's primary one. */
  const detailSections = $derived.by(() => {
    if (!view) return [];
    const { households, primary, suggestions } = asView(view);
    const suggested = suggestions.find((one) => one.id === expanded);
    const householdId = suggested ? (suggested.householdId ?? primary) : detail?.householdId;
    return households.find((one) => one.id === householdId)?.sections ?? [];
  });
  /* .by, not a bare expression: read at the top level, `detail` would be
     narrowed to its initial null. */
  const chooserAsk = $derived.by(() => {
    const today = detail?.today ?? (view ? asView(view).today : null);
    return today ? modes.askOf(detailSections, today) : null;
  });
  let wide = $state(false);
  $effect(() => {
    const media = matchMedia(WIDE_QUERY);
    const set = () => { wide = media.matches; };
    set();
    media.addEventListener("change", set);
    return () => media.removeEventListener("change", set);
  });

  /* Where focus goes back to when the rows stop editing: the pencil, or a
     suggestion's `review & amend →`. */
  const EDIT_HOME = ".ivedit, .ivamend";
  /** Focus a control in the open drawer (or its head), once it is drawn. @param {string} selector */
  async function focusInDrawer(selector) {
    await tick();
    const id = expanded;
    if (!id) return;
    const el = /** @type {HTMLElement | null} */ (
      document.getElementById(`${id}-view`)?.querySelector(selector) ?? document.getElementById(id)?.querySelector(selector));
    el?.focus({ preventScroll: true });
    if (el?.isContentEditable) getSelection()?.collapse(el, el.childNodes.length);
  }

  /** The chooser card's pick: the row takes it, or the snooze is sent. @param {string} value */
  function pickChoice(value) {
    const snooze = modes.pick(value);
    if (!snooze || !detail) return;
    const { item, until } = snooze;
    if (until <= detail.today) { footProblem = "not yet — snooze to a day after today"; return; }
    runFoot("snooze", () => snoozeCommand(item, until), `${item.title} snoozed until ${longDate(until)}`);
  }

  async function saveEdit() {
    const title = modes.edit.draft?.title.trim() ?? "";
    if (await modes.edit.commit()) {
      wake(`saved · ${title}`);
      focusInDrawer(".ivedit");
    }
  }

  /* Complete records what the rows hold: the date, the cost, the notes.
     The next due date is the engine's (#1324), read back from its reply.
     Sent on `record`, not held for an undo: the rows were the chance to
     change it. */
  async function recordCompletion() {
    const out = modes.completion();
    if ("refusal" in out) { modes.completeProblem = out.refusal; return; }
    if (footBusy) return;
    const { item, fields } = out;
    footBusy = "complete";
    modes.completeProblem = null;
    try {
      const nextDate = dueDateIn(await applyCommand(completeCommand(item, fields)), item.householdId, item.id);
      modes.cancelComplete();
      if (!nextDate) collapseRow();
      view = await readHome();
      if (nextDate) await rereadDetail();
      wake(`Completed${nextDate ? ` · next due ${shortDate(nextDate)}` : ""} · ${item.title}`);
      if (nextDate) focusInDrawer('[aria-label^="Complete "]');
    } catch (error) {
      modes.completeProblem = /** @type {{ message?: string }} */ (error)?.message ?? "couldn't complete it — try again";
    } finally {
      footBusy = null;
    }
  }

  /* Escape: the chooser first (focus back to its value; the card hears it
     itself too, and whichever hears it first marks it handled), then the
     edit or the completion (focus back to the pencil or the pill). Ahead of
     home's own Escape, which puts the drawer away; the preview's Escape is
     the preview's. */
  $effect(() => {
    if (!modes.id) return;
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || previewDoc) return;
      const chooser = modes.choosing;
      const editing = Boolean(modes.edit.id);
      if (!modes.escape()) return;
      event.preventDefault();
      event.stopPropagation();
      if (!chooser) focusInDrawer(editing ? EDIT_HOME : '[aria-label^="Complete "]');
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  /* A press off the chooser card puts it away at once; a press on another
     value switches it, on its own value closes it (EditSession.choose).
     That press is swallowed by the drawer once, as the preview's is. */
  $effect(() => {
    if (!modes.choosing) return;
    /** @param {PointerEvent} event */
    const onPress = (event) => {
      if (pressKeepsChooser(event.target)) return;
      modes.closeChooser(false);
      swallowClick = true;
    };
    window.addEventListener("pointerdown", onPress, true);
    return () => window.removeEventListener("pointerdown", onPress, true);
  });

  /** @type {import('./drawer-acts.js').DrawerActs} */
  const drawerActs = $derived({
    busy: footBusy ?? (modes.edit.busy ? "save" : null),
    problem: modes.edit.problem ?? modes.edit.refusal ?? modes.completeProblem ?? footProblem,
    modes,
    sections: detailSections,
    onsnooze: (from) => {
      const item = commandItem();
      footProblem = null;
      if (item) modes.snooze(item, from);
    },
    oncomplete: () => {
      const item = commandItem();
      if (!item) return;
      footProblem = null;
      modes.startComplete(item, item.today);
      focusInDrawer("[data-pick]");
    },
    onedit: () => {
      const item = commandItem();
      if (!item) return;
      footProblem = null;
      modes.startEdit(item);
      focusInDrawer('[data-ed="title"]');
    },
    onsave: saveEdit,
    onrecord: recordCompletion,
    oncancel: () => {
      const editing = Boolean(modes.edit.id);
      modes.end();
      focusInDrawer(editing ? EDIT_HOME : '[aria-label^="Complete "]');
    },
    onamend: startAmend,
    onaccept: addAmended,
    onattach: async (file) => {
      const item = commandItem();
      if (!item || footBusy) return;
      footBusy = "attach";
      footProblem = null;
      try {
        await attachItemDocument(item.householdId, item.id, file, crypto.randomUUID());
        await rereadAll();
        wake(`${file.name} attached to ${item.title}`);
      } catch (error) {
        footProblem = /** @type {{ message?: string }} */ (error)?.message ?? "couldn't attach it — try again";
      } finally {
        footBusy = null;
      }
    },
    onretire: () => {
      const item = commandItem();
      if (item) runFoot("retire", () => archiveCommand(item), `${item.title} retired`, { leave: true });
    },
    oncopy: copyAddress,
  });

  /** @param {KeyboardEvent} event */
  function onWindowKeydown(event) {
    if (event.key === "Escape" && expanded) collapseRow();
  }
  /** @param {MouseEvent} event */
  function onWindowClick(event) {
    if (!expanded) return;
    if (swallowClick) { swallowClick = false; return; }
    /* #1319: while the rows are being edited or a completion asked for, a
       press elsewhere leaves the drawer as it is (round 8's own rule) */
    if (modes.id === expanded && (modes.edit.id || modes.completing)) return;
    /* Inside the open row or its panel: stay. On another expandable row: that
       row's own handler is switching to it. On the preview card beside the
       drawer, or the reader over home (#1319): stay. Anywhere else: close.
       Read off the event's path, not the target's ancestors: a press that
       replaces its own button (the foot row's snooze) has left the target
       detached by the time the click reaches the window. */
    const inside = event.composedPath().some((node) =>
      node instanceof Element && node.matches("a.item, .itemview, [data-preview-card], [data-chooser-card], .rd-layer"));
    if (inside) return;
    collapseRow();
  }

  /* Arriving on the address rather than clicking into it: put the row on
     screen and open it, then hand the entry the state it would have had if
     you had clicked, so Forward and Back agree with each other. */
  async function openFromAddress() {
    const id = page.url.searchParams.get("item");
    if (!id || /** @type {any} */ (page.state).orbitItem === id) return;
    revealTarget = id;
    replaceState(resolve(`/home?item=${encodeURIComponent(id)}`), { orbitItem: id });
    await tick();
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "auto" });
  }

  /* ---- #1319: A SUGGESTION REVIEWED IN ITS DRAWER -----------------------
     owner-decisions §34 ("suggestions are reviewed in their home drawer",
     superseding §27's belt card). `review & amend →` puts the suggestion's
     drawer into the rows' own editing (EditRows.svelte), the relay's
     proposal standing in for the item it would become (proposedItemOf); the
     choosers stand beside it as a filed item's do. `add to orbit` sends the
     rows as the amended item on the two-tap decision's own operation id
     (amendReceipt), into the section the rows chose. */
  function startAmend() {
    const suggestion = asView(view).suggestions.find((one) => one.id === expanded);
    if (!suggestion?.receiptId) return;
    const householdId = suggestion.householdId ?? asView(view).primary;
    if (!householdId) {
      armed = { id: suggestion.id, act: null };
      mailProblem = "This account has no household yet";
      return;
    }
    const sections = asView(view).households.find((one) => one.id === householdId)?.sections ?? [];
    const sectionId = (sections.find((one) => one.visible !== false) ?? sections[0])?.id ?? null;
    mailProblem = null;
    armed = { id: null, act: null };
    previewDoc = null;
    modes.startEdit(proposedItemOf(suggestion, { householdId, sectionId }));
    focusInDrawer('[data-ed="title"]');
  }
  /**
   * The rows' save for a suggestion: approved as amended, or refused in the
   * rows' own words (EditSession says it under the rows).
   * @param {import('$lib/data/commands.js').CommandItem} item
   * @param {Partial<import('$lib/data/commands.js').CommandItem>} edits
   */
  async function addSuggestion(item, edits) {
    const suggestion = asView(view).suggestions.find((one) => one.id === item.id);
    if (!suggestion) throw new Error("not added — this suggestion has gone");
    const { item: amended, sectionId } = amendedOf(item, edits);
    const problem = await amendReceipt(suggestion, amended, sectionId);
    if (problem?.startsWith("The item is recorded")) {
      throw new Error("not finished — the item is recorded, but its documents need another try: add it again");
    }
    if (problem) throw new Error(`not added — ${problem}`);
  }
  async function addAmended() {
    const title = modes.edit.draft?.title.trim() ?? "";
    if (await modes.edit.commit()) {
      collapseRow();
      wake(`added to your orbit · ${title}`);
    }
  }

  const operationIds = new SvelteMap();
  /**
   * @param {any} suggestion
   * @param {"approve" | "dismiss"} act
   */
  async function tapReceipt(suggestion, act) {
    mailProblem = null;
    if (!suggestion.receiptId) return; // a #454 fixture suggestion has no mail behind it yet
    if (armed.id !== suggestion.id || armed.act !== act) {
      armed = { id: suggestion.id, act };
      return;
    }
    busyReceipt = suggestion.id;
    try {
      if (act === "approve") {
        if (!operationIds.has(suggestion.receiptId)) operationIds.set(suggestion.receiptId, crypto.randomUUID());
        const result = await approveReceipt(suggestion, asView(view).primary, operationIds.get(suggestion.receiptId));
        if (result.outcome === "partial_success") {
          /* The item exists but its documents didn't make it: the SAME
             operation id retries the SAME body — never a second item. */
          mailProblem = "The item is recorded, but its documents need another try — tap again to finish.";
          return;
        }
        operationIds.delete(suggestion.receiptId);
      } else {
        await dismissReceipt(suggestion.receiptId);
      }
      armed = { id: null, act: null };
      view = await readHome();
    } catch (error) {
      mailProblem = /** @type {any} */ (error)?.message ?? String(error);
    } finally {
      busyReceipt = null;
    }
  }

  /**
   * The pocket's review sheet, raised in place from a suggestion's row or
   * its hollow body on the dial (round 3 §4): approves what the reader
   * amended into the section they chose, on the same idempotent protocol
   * and operation id as the two-tap decision. Answers the problem, if any.
   * @param {import('$lib/data/workspace.js').ReceiptSuggestion} suggestion
   * @param {import('$lib/data/workspace.js').ItemProposal} item
   * @param {string | null} sectionId
   * @returns {Promise<string | null>}
   */
  async function amendReceipt(suggestion, item, sectionId) {
    if (!suggestion.receiptId) return "not added — try again";
    busyReceipt = suggestion.id;
    try {
      if (!operationIds.has(suggestion.receiptId)) operationIds.set(suggestion.receiptId, crypto.randomUUID());
      const result = await approveReceipt(suggestion, asView(view).primary, operationIds.get(suggestion.receiptId), item, sectionId);
      if (result.outcome === "partial_success") {
        return "The item is recorded, but its documents need another try — add it again to finish.";
      }
      operationIds.delete(suggestion.receiptId);
      view = await readHome();
      return null;
    } catch (error) {
      return /** @type {any} */ (error)?.message ?? String(error);
    } finally {
      busyReceipt = null;
    }
  }

  /* Everything below the chrome is the view-model (#451): the same transform
     the unit tests pin renders the dial, the manifest and the palette. */
  /** @type {any[]} */
  const bodies = $derived(
    view ? dialBodiesOf(asView(view).household, { suggestions: /** @type {any} */ (asView(view).suggestions), today: asView(view).today }) : [],
  );
  /** @type {any} */
  const groups = $derived(
    view ? manifestGroupsOf(asView(view).household, { suggestions: /** @type {any} */ (asView(view).suggestions), today: asView(view).today }) : null,
  );
  /* §14 (#469): the manifest rendered as the corridor — this household's
     full scrollback, suggestions merged in date order. */
  const corridor = $derived(
    (() => {
      const current = view ? asView(view) : null;
      return current?.household
        ? corridorOf(
            { households: [current.household], activeHouseholdId: current.primary },
            current.today,
            { suggestions: /** @type {any} */ (current.suggestions) },
          )
        : null;
    })(),
  );
  // ---- the desk's own search strip (#1161, "C · unrolled"; §2.4's search
  // shared with the phone via pocket-search.js rather than a second
  // implementation — design/v19/search/round-1/BUILD.md)

  /**
   * @typedef {import('./pocket-search.js').SearchItem} SearchItem
   * @typedef {import('./pocket-search.js').SearchDocument} SearchDoc
   * @typedef {{ kind: string, paint: string, documentCount: number, suggestion?: boolean }} BodyPaint
   * @typedef {BodyPaint & { days: number | null, size: number, costMinor: number | null,
   *   currency: string, costIsEstimate: boolean }} DialBody
   * @typedef {{ itemId: string, title: string, days: number | null, body: DialBody | null,
   *   hitDocs: string[] }} StripMatch
   */

  /* `bodyMark`'s own neutral stand-in for an unscheduled match, which draws no
     planet (BUILD.md §1) — and, doubling as the snippet parameter's default
     value below, the only way to give `b` a real inferred shape rather than
     `any`: a JSDoc annotation directly in a `{#snippet}` parameter list reads
     fine to svelte-check but crashes the production rolldown build (see
     scripts/check-rolldown-jsdoc-trap.mjs and CorridorRow.svelte's header). */
  /** @type {BodyPaint} */
  const EMPTY_BODY = { kind: "", paint: "", suggestion: false, documentCount: 0 };

  let stripOpen = $state(false);
  let searchQuery = $state("");
  /** @type {import('./pocket-search.js').SearchDocument[]} */
  let searchDocuments = $state([]);
  /** @type {object | null} */
  let searchDocumentsFor = null;

  /** #1151 W1-Q8: shared with the pocket's own copy (home/pocket.svelte)
   *  via pocket-search.js's readSearchDocuments, which also carries the
   *  concurrency cap (#1151 W1-R9) this copy never had. */
  async function loadSearchDocuments() {
    const household = view?.household;
    const householdId = view?.primary;
    if (!household || !householdId || searchDocumentsFor === household) return;
    searchDocumentsFor = household;
    const carrying = (household.items ?? []).filter((item) => item.status === "active" && (item.documentCount ?? 0) > 0);
    // Additive: an item whose papers cannot be read loses its papers from the
    // results, not the search.
    const found = await readSearchDocuments(
      carrying, readItemDocuments, householdId, () => searchDocumentsFor !== household,
    );
    if (searchDocumentsFor === household) searchDocuments = found;
  }

  const searchRows = $derived(groups ? [...groups.attention, ...groups.later] : []);
  const searchResults = $derived(
    searchPocket(searchQuery, { items: searchRows, attention: groups?.attention ?? [], documents: searchDocuments }),
  );

  /* The raw item behind a manifest/search row, for the one command the strip
     fires directly (#1162): completing the closest thing due. Same shape and
     source as the pocket's own `rawItems` (home's pocket.svelte). */
  const rawItems = $derived(new Map((view?.household?.items ?? []).map((item) => [item.id, item])));

  /* #1162: the two note-line acts BUILD.md left inert. "complete" fires the
     same completeCommand the item page and the pocket's own quick-complete
     use, arm-then-fire (`$lib/pocket/arm.js`, the shared helper arm.js's own
     header says the desk should reach for rather than a sixth inline copy).
     "add" carries the typed name to /create exactly as the pocket's search
     already does (#1120). Both show together at rest; a typed query with
     real matches shows neither (BUILD.md §1). */
  let completeArmed = $state(false);
  const completeArm = createArm({ onchange: (next) => { completeArmed = next; } });
  let stripProblem = $state(null);

  const stripActs = $derived(stripActsOf({
    searchQuery, nothing: searchResults.nothing, query: searchResults.query,
    closest: groups?.closest ?? null, completeArmed,
  }));

  /** @param {{ id: string, title: string }} target */
  async function fireCompleteAct(target) {
    stripProblem = null;
    if (!completeArm.tap()) return; // first tap only arms it
    const raw = rawItems.get(target.id);
    if (!raw || !view?.primary) return;
    try {
      const completedDate = asView(view).today;
      await applyCommand(completeCommand(/** @type {any} */ ({ ...raw, householdId: view.primary }), { completedDate }));
      stripOpen = false;
      view = await readHome();
    } catch (error) {
      stripProblem = /** @type {any} */ (error)?.message ?? "couldn't complete it — try again";
    }
  }

  /** @param {string} name */
  function goToCreate(name) {
    stripOpen = false;
    const query = name ? `?${new URLSearchParams({ name })}` : "";
    goto(resolve(/** @type {any} */ (`/create${query}`)));
  }

  /** @param {{ kind: "complete" | "add", target?: any, name?: string }} a */
  function fireAct(a) {
    if (a.kind === "complete") fireCompleteAct(a.target);
    else goToCreate(a.name ?? "");
  }

  function onExploreFocus() {
    stripOpen = true;
    stripProblem = null;
    loadSearchDocuments();
  }
  function onExploreBlur() {
    setTimeout(() => { stripOpen = false; completeArm.disarm(); }, 150);
  }
  /* #1197: the server draws #explore (#842), so a reader can be in the field
     before hydration binds onfocus, and focus does not fire again: the strip
     stayed shut while the typed query filtered nothing visible. Catch up on
     the focus nobody was listening for, as #856 and #1064 did for a missed
     keystroke and press. */
  onMount(() => {
    if (document.activeElement?.id === "explore") onExploreFocus();
  });

  /* At rest (empty query) the strip shows the same two rows the palette
     showed (BUILD.md §1): the attention group's own due-or-later two, not
     searchPocket's unfiltered empty branch. */
  const emptyStripRows = $derived((groups?.attention ?? []).filter(dueOrLater).slice(0, 2));
  /** @param {SearchItem} row */
  function dueOrLater(row) { return row.days !== null && row.days >= 0; }
  const stripItems = $derived(searchQuery ? searchResults.items : emptyStripRows);
  const stripDocuments = $derived(searchQuery ? searchResults.documents : []);

  /* The one selectable list, in the order §1 names: items (manifest order,
     soonest first), then documents, then the note line's own act(s) (#1162)
     — trailing, since a query with real matches never shows one at all
     (BUILD.md §1). The no-match sentence itself carries no act and is never
     in this list. */
  /* Typed as declarations, not inline arrow parameters: a JSDoc comment on
     an arrow's parameter compiles to server output vite dev cannot run
     (#1138). */
  /** @param {SearchItem} item */
  function itemEntry(item) {
    return { kind: /** @type {const} */ ("item"), itemId: item.id, title: item.title, days: item.days };
  }
  /** @param {SearchDoc} doc */
  function docEntry(doc) {
    return { kind: /** @type {const} */ ("doc"), itemId: doc.itemId, title: doc.name, itemTitle: doc.itemTitle };
  }
  const selectable = $derived([
    ...stripItems.map(itemEntry),
    ...stripDocuments.map(docEntry),
    ...stripActs,
  ]);
  let selectedIndex = $state(0);
  const selectedPos = $derived(selectable.length ? Math.min(selectedIndex, selectable.length - 1) : null);
  const selectedEntry = $derived(selectedPos === null ? null : selectable[selectedPos]);

  /** @param {number} direction */
  function stepSelection(direction) {
    if (!selectable.length) return;
    const current = Math.min(selectedIndex, selectable.length - 1);
    selectedIndex = (current + direction + selectable.length) % selectable.length;
  }
  /** @param {{ itemId: string }} mark */
  function selectMark(mark) {
    const idx = selectable.findIndex((entry) => entry.itemId === mark.itemId);
    if (idx >= 0) selectedIndex = idx;
  }
  /** @param {{ itemId: string }} mark */
  function openMark(mark) {
    selectMark(mark);
    openSearchResult(mark.itemId);
  }
  /** @param {{ kind: "complete" | "add" }} a */
  function selectAct(a) {
    const idx = selectable.indexOf(a);
    if (idx >= 0) selectedIndex = idx;
  }

  /** @param {KeyboardEvent} event */
  function onExploreKeydown(event) {
    if (event.key === "Escape") {
      completeArm.disarm();
      /** @type {HTMLElement} */ (event.currentTarget).blur();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); stepSelection(1); return; }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); stepSelection(-1); return; }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!selectedEntry) return;
    if (selectedEntry.kind === "complete" || selectedEntry.kind === "add") { fireAct(selectedEntry); return; }
    openSearchResult(selectedEntry.itemId);
  }

  /* ---- the strip's own layout: the dial's bodies, never recomputed, plus
     the pure geometry in strip-layout.js (BUILD.md §3/§4). ---- */
  const bodiesById = $derived(new Map(bodies.map((b) => [b.id, b])));
  const stripToday = $derived(view ? asView(view).today : new Date().toISOString().slice(0, 10));
  const stripTodayX = $derived(xOfDays(0));
  const stripMonthTicks = $derived(stripOpen ? monthTicks(stripToday) : []);
  /** @param {number} days */
  const stripDateOf = (days) =>
    new Date(Date.parse(`${stripToday}T00:00:00Z`) + days * 86400000)
      .toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

  const stripMarks = $derived.by(() => {
    if (!stripOpen) return [];
    /** @type {Map<string, StripMatch>} */
    const byItem = new SvelteMap();
    for (const row of stripItems) {
      const b = bodiesById.get(row.id) ?? null;
      byItem.set(row.id, { itemId: row.id, title: row.title, days: b ? b.days : row.days, body: b, hitDocs: [] });
    }
    for (const doc of stripDocuments) {
      let m = byItem.get(doc.itemId);
      if (!m) {
        const b = bodiesById.get(doc.itemId) ?? null;
        const row = searchRows.find((r) => r.id === doc.itemId);
        m = { itemId: doc.itemId, title: doc.itemTitle, days: b ? b.days : (row?.days ?? null), body: b, hitDocs: [] };
        byItem.set(doc.itemId, m);
      }
      m.hitDocs.push(doc.name);
    }
    const raw = [...byItem.values()].map((m) => {
      /* `days` rather than `m.days` from here on: a ternary keyed on a
         separately-computed `unscheduled` boolean does not narrow `m.days`
         itself, only one keyed on `days === null` directly does. */
      const days = m.days;
      const unscheduled = days === null;
      const x = days === null ? UNSCHEDULED_X : xOfDays(days);
      const meta = days === null
        ? `no date · ${m.body ? money(m.body.costMinor, m.body.currency, m.body.costIsEstimate) : ""}`
        : `${tlabel({ days })} · ${stripDateOf(days)} · ${money(m.body?.costMinor ?? null, m.body?.currency ?? "GBP", m.body?.costIsEstimate ?? false)}`;
      const lines = [
        { cls: "title", text: m.title, size: 12.5 },
        { cls: "meta", text: meta, size: 11 },
        ...m.hitDocs.map((name) => ({ cls: "docs hitdoc", text: `◆ ${name}`, size: 11 })),
      ];
      const width = Math.max(...lines.map((l) => textWidth(l.text, l.size)));
      return { ...m, unscheduled, x, lines, width };
    });
    return assignTiers(raw).map((m) => {
      const r = m.body ? Math.max(3.5, m.body.size * 1.1) : 3.5;
      const tier = m.unscheduled ? 0 : m.tier;
      const flip = m.unscheduled ? true : m.flip;
      const showLabel = m.unscheduled || m.labelled || selectedEntry?.itemId === m.itemId;
      const run = TIER_RUN_Y[tier];
      const n = m.lines.length;
      const lineNodes = m.lines.map((line, k) => ({
        ...line,
        y: tier === 0 ? run - 5 - (n - 1 - k) * 13 : run + 12 + k * 13,
      }));
      const leaderPath = leaderPathOf({ x: m.x, width: m.width, r, tier, flip });
      return { ...m, r, tier, flip, showLabel, anchorX: flip ? m.x - 2 : m.x + 2, lineNodes, leaderPath };
    });
  });
  const stripBusyX = $derived(stripMarks.map((m) => m.x));
  /** @param {{ itemId: string }} m */
  const isMarkSelected = (m) => selectedEntry?.itemId === m.itemId;

  $effect(() => {
    document.body.classList.toggle("searching", stripOpen);
    return () => document.body.classList.remove("searching");
  });

  const todayLine = $derived(
    view
      ? new Date(asView(view).today + "T00:00:00Z")
          .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
          .replace(",", "").toUpperCase()
      : "",
  );
  /* the inbox orb's truth: arrivals awaiting the two-tap */
  const mailWaiting = $derived(view ? (asView(view).suggestions?.length ?? 0) : 0);
  /* CorridorRow's own suggestion lookup (#624/#782): passed down as a prop
     rather than the whole view, so the row component's type is the slice it
     actually reads. */
  const suggestions = $derived(view ? asView(view).suggestions : undefined);
  /* #1145: the suggestion drawer counts the days to burn-up from the
     workspace's own today (pinned under fixtures), as the phone's does. */
  const today = $derived(view ? asView(view).today : new Date().toISOString().slice(0, 10));
  /* #763: how many are overdue right now — the OS badge and the tab title
     both read this, never the server, so both hold whatever this browser's
     own chart just worked out. */
  const overdueCount = $derived(corridor?.overdue?.length ?? 0);
  $effect(() => {
    showUrgentCount(overdueCount);
  });
  const initials = $derived(
    (view ? (asView(view).user?.displayName ?? "") : "")
      .split(/\s+/)
      .map((word) => word[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase(),
  );

  /* The month ring: positions are the design's own (hand-nudged a few px off
     the pure circle, kept verbatim); the TEXT walks with the real date, the
     current month at 12 o'clock (POL-3). */
  const MONTH_POS = [
    [190, 31], [271, 53], [330, 112], [352, 194], [330, 274], [271, 333],
    [190, 355], [109, 333], [50, 274], [28, 194], [50, 112], [109, 53],
  ];
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const monthLabels = $derived(
    MONTH_POS.map(([x, y], k) => ({
      x, y,
      label: MONTHS[((view ? new Date(view.today + "T00:00:00Z").getUTCMonth() : 7) + k) % 12],
    })),
  );

  /** @type {(deg: number, radius: number) => [number, number]} */
  const point = (deg, radius) => [
    Math.round((190 + Math.cos((deg * Math.PI) / 180) * radius) * 10) / 10,
    Math.round((190 + Math.sin((deg * Math.PI) / 180) * radius) * 10) / 10,
  ];
  /* A trail rides just behind the body on its own orbit (suggestions: just
     ahead) — the arc the design drew for everything close to the sun. */
  /** @type {(b: any) => string} */
  const trailPath = (b) => {
    const angle = b.days - 90;
    const [from, to] = b.suggestion ? [angle + 3, angle + 7] : [angle - 7, angle - 3];
    const [x1, y1] = point(from, b.placement.radius);
    const [x2, y2] = point(to, b.placement.radius);
    return `M ${x1} ${y1} A ${b.placement.radius} ${b.placement.radius} 0 0 1 ${x2} ${y2}`;
  };
  /** @type {(b: any) => string} */
  const trailStroke = (b) =>
    b.suggestion ? "var(--upcoming)" : b.overdue ? "var(--overdue)" : "var(--warm)";
  const trailed = $derived(
    bodies.filter((b) => (b.suggestion ? b.trail : b.trail && (b.overdue || b.paint === "amber"))),
  );
  /* The dotted accent line strings the next three routine services together. */
  const constellationPoints = $derived(
    bodies
      .filter((b) => !b.suggestion && b.kind === "service")
      .slice(0, 3)
      .map((b) => `${b.placement.x},${b.placement.y}`)
      .join(" "),
  );
  const closest = $derived(bodies.find((b) => b.closest) ?? null);
  const firstOverdue = $derived(bodies.find((b) => b.overdue) ?? null);
  /* #1005: a one-off is a dashed ring in its own band's colour -- an outline
     with nothing inside it, because there is nothing coming round. Past its
     date it wears the quiet ink tone: ended, not owed. */
  /** @type {(b: any) => string} */
  const expiryStroke = (b) =>
    b.paint === "ended" ? "var(--ink-mid)"
      : b.paint === "amber" ? "var(--warm)"
        : b.paint === "sky" ? "var(--upcoming)"
          : "var(--ok)";


  onMount(() => {
    const query = window.matchMedia(DESK);
    /** @type {(() => void) | null} */
    let teardown = null;
    let disposed = false;

    /* ---- #1064: HOME IS DRAWN LONG BEFORE IT CAN ANSWER -------------------
     * The server renders home whole (#842) — the dial, the corridor, the
     * avatar and the menu under it — but nothing on it answers a press until
     * readHome() below has resolved and sync() has bound the behaviour. A
     * press on the account orb inside that window lands on markup with no
     * listener on it and is dropped, and nothing replays it: the panel simply
     * never opens. That is the fault #856 fixed on /create, where the first
     * keystroke was lost the same way, and it takes the same two answers —
     * catch up on the press nobody was listening for, and say out loud when
     * the screen went live.
     *
     * #1243: the north star is the same kind of press. It opens the quick add
     * (or, on the empty sky, sends the reader to "/"), and it was left out of
     * the catch-up, so a reader who pressed it while readHome() was still out
     * saw nothing happen and had to press again. CI caught it as the quick
     * add test's drawer never opening (pipeline 2236).
     */
    /** @type {HTMLElement | null} */
    let missedPress = null;
    /** @param {Event} event */
    const rememberPress = (event) => {
      const target = event.target;
      if (target instanceof Element)
        missedPress = /** @type {HTMLElement | null} */ (target.closest("button.orb, #morb, #nstar"));
    };
    /* Capture phase, so the press is recorded before anything else can stop
       it. A keyboard reader is recorded here too: both dialects' toggles are
       real <button>s, so Enter and Space fire a click of their own. */
    document.addEventListener("click", rememberPress, { capture: true });
    const stopRemembering = () => document.removeEventListener("click", rememberPress, { capture: true });
    const applyMissedPress = () => {
      stopRemembering();
      /* The last press wins: two presses before the screen was live are one
         reader pressing a second time because the first did nothing. */
      if (missedPress?.isConnected) missedPress.click();
      missedPress = null;
    };

    const mountDialect = () => {
      teardown?.();
      /* ---- #1074: THE ACCOUNT PANEL IS CHROME, NOT HOUSEHOLD DATA --------
       * The avatar, Inbox, Settings, the THEME row and sign-out belong to
       * every reader on /home, and the server renders all of it whether or
       * not this reader is in a household. It used to be bound inside
       * mountHome/mountPocket, which only the branch below them runs — so a
       * reader on the empty sky was shown the whole menu and could not open
       * it, and Settings, Inbox, the theme and sign-out were unreachable
       * from home for exactly the reader most likely to want them.
       *
       * It binds here, above the branches, so no branch can forget it: this
       * is the one line every path through the mount shares.
       */
      /* #1120: on a phone the account menu is the kit's hatch, which
         pocket.svelte owns and binds itself, so only the desk's needs a mount. */
      const stopAccount = query.matches ? mountAccount() : () => {};
      /** @param {() => void} stopDialect */
      const withAccount = (stopDialect) => () => { stopDialect(); stopAccount(); };
      /* §11 (#453): no household means the labelled sky in either dialect —
         same bearings, label only, click to ask. */
      if (view?.emptySky) {
        if (query.matches) {
          /* #840: the adrift copy still says "follow the north star to start
             your own", but there is no household yet for the drawer's quick-add
             to write into — the create card that actually starts one only ever
             appears at /, so the star sends a reader there instead of opening
             the drawer while the sky is empty. */
          const controller = new AbortController();
          document.getElementById("nstar")?.addEventListener(
            "click", () => location.assign("/"), { signal: controller.signal });
          const stopSky = mountEmptySky({ galaxy: view.galaxy, onAsk: (id, name, requested) => { if (!requested) askTarget = { id, name }; } });
          teardown = withAccount(() => { controller.abort(); stopSky(); });
        } else {
          /* The pocket's labelled sky is a list; asking rides data attributes
             because the hidden dialect must never bind listeners. */
          const controller = new AbortController();
          for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-ask]"))) {
            row.addEventListener("click", () => {
              if (row.dataset.askRequested !== "true") askTarget = { id: /** @type {string} */ (row.dataset.ask), name: /** @type {string} */ (row.dataset.askName) };
            }, { signal: controller.signal });
          }
          teardown = withAccount(() => controller.abort());
        }
        return;
      }
      /* Tear the old dialect down before standing the new one up. */
      teardown = withAccount(query.matches
        /* §15, the sky wave: the pack skies are seeded streams, so the fixture
           switch travels with the mount — alive per load in the product, pinned
           to the workspace under ORBIT_FIXTURES, which is what lets the gate
           photograph the same sky twice. */
        ? mountHome({ galaxy: asView(view).galaxy, primary: asView(view).primary,
                      fixtures: Boolean(data?.fixtures), workspace: asView(view).primary ?? "",
                      onopendocs: openItemDocuments })
        /* #1120: the pocket binds its own controls (pocket.svelte, the kit's
           sheets and rows); its approve, dismiss and refresh are handed to it
           as props below. */
        : () => {});
    };
    const sync = () => {
      delete document.body.dataset.homeReady;
      mountDialect();
      /* `body[data-home-ready]` is the observable moment home's listeners
         exist, so a reader — or a test — can wait for the screen to be ABLE
         to answer rather than for markup the server already sent. Set last,
         after every listener above is attached, and taken away again whenever
         the screen is torn down or re-mounted into the other dialect. */
      document.body.dataset.homeReady = "true";
    };
    /* The home view comes through the seam, live (#451). onMount must stay
       synchronous — an async callback's return value is discarded, which
       would leak every listener the teardown exists to remove — so the read
       resolves into a closure and mounting follows it, after tick() has put
       the data-driven markup in the document for the behaviour to bind. */
    readHome().then(async (data) => {
      if (disposed) return;
      view = data;
      /* #1151 F8: a later successful read must clear an earlier failure's
         banner — it never did, so the page kept claiming it could not
         reach the home even once it plainly could again. */
      homeLoadProblem = null;
      await tick();
      if (disposed) return;
      sync();
      /* Now that it can answer, answer the press that arrived while it could
         not (#1064). Before openFromAddress() below, because it came first. */
      applyMissedPress();
      resync = sync;
      query.addEventListener("change", sync);
      /* #424: the address may already name a row. Do it before the scroll
         restore below, which a history return owns and a deep link does not. */
      openFromAddress();
      driveFixture();
      if (restoreScroll !== null) {
        const y = restoreScroll;
        restoreScroll = null;
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
    }).catch((error) => {
      /* #1151 W1-R4: this read had no `.catch()` at all, so a backend outage
         left the server-rendered page up with nothing behind it ever bound
         — no listeners, no error, just a screen that looked alive and
         answered nothing. */
      if (disposed) return;
      homeLoadProblem = /** @type {any} */ (error)?.message ?? String(error);
    });
    return () => {
      disposed = true;
      stopRemembering();
      query.removeEventListener("change", sync);
      teardown?.();
      delete document.body.dataset.homeReady;
    };
  });
</script>

<svelte:head>
  <title>{overdueCount > 0 ? `(${overdueCount}) ` : ""}Orbit</title>
</svelte:head>

<!-- #424: Escape and a click outside close the expanded row. Scroll does
     NOT — see the note on the law above; that is the one place this parts
     company with §14's drawer rule, deliberately. -->
<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

{#if homeLoadProblem}
  <p class="p-error" role="alert">Orbit could not reach your home: {homeLoadProblem}</p>
{/if}

<!-- #466/#1120: the pocket's two-tap decisions land on the same idempotent
     approve protocol the desk rows use (one operation id per receipt), and
     answer with the problem, if any, for the sheet to show. -->
<Pocket {view} {arrive} onsignedout={(redirectTo) => leave?.descendFrom(redirectTo)} onmenu={readyDescent}
        onapprove={async (suggestion) => { armed = { id: suggestion.id, act: "approve" }; await tapReceipt(suggestion, "approve"); return mailProblem; }}
        ondismiss={async (suggestion) => { armed = { id: suggestion.id, act: "dismiss" }; await tapReceipt(suggestion, "dismiss"); return mailProblem; }}
        onamend={amendReceipt}
        onchanged={async () => {
          /* #1151 W1-R4: the same unguarded read as the onMount one above —
             a failure here left the pocket's own re-read silently going
             nowhere, with no error shown. */
          try {
            view = await readHome();
            // #1151 F8: same reset as the onMount read above — a success
            // here must clear a banner an earlier failure left behind.
            homeLoadProblem = null;
          } catch (error) {
            homeLoadProblem = /** @type {any} */ (error)?.message ?? String(error);
          }
        }} />

<!-- The flight's surfaces: the dawn the climb leaves from, the dusk the
     descent lands on, and the canvas, mark and void-name between them. Each
     is here only for the journey that needs it. -->
{#if launching}<Dawn />{/if}
<Leave bind:this={leave} {launching} leaving={fixtureFlight === "down"} name={view?.household?.name ?? ""}
       homes={view && !view.emptySky ? othersOf(view.galaxy, view.primary) : []} />

<div class="desk" class:arrive role="main">
<!-- #843: sr-only, since the wordmark and dial carry the title visually. -->
<h1 class="sr-only">Orbit</h1>
<!-- THE REFUSAL LINE (#1033). Above everything, because it is the one thing
     on this screen that is about the reader rather than about their things,
     and it is gone the moment they have read it: nothing dismisses it,
     because asking for it already spent it. -->
{#if refusedAt}
  <p class="refused" role="status">
    A sign-in with your password was refused {agoLong(refusedAt, new Date().toISOString())}.
    Nobody got in — <a href={resolve("/settings")}>change your password</a>.
  </p>
{/if}
<!-- ══ THE SKY WAVE (§15, the v1.3.0 roster) ═════════════════════════════════
     Three packs gained their own sky in the same batch, and every layer below
     belongs to exactly one of them. All of them live INSIDE .desk, which is
     display:contents on a desk and display:none on a phone — so the pocket's
     own ratified starfield is clean by construction rather than by a selector
     somebody has to remember, and the rules in home.css are scoped `.desk`
     for the same reason the walls are (see the note there).

     AFTER DARK — THE GALACTIC PLANE. First in the document because it is the
     furthest thing in the sky: the pack's own stars stream in FRONT of the
     galaxy, never behind it. Three materials in one field — the dust glow, the
     river's dense population, the lanes that absorb it — rolled a chunk at a
     time by sky-plane.js and thrown away for good once they have passed. -->
<div class="plane" id="plane" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <!-- a lobe is not a circle of colour, it is a soft falloff: five stops
           approximating a gaussian, so overlapping lobes build an irregular
           river rather than a row of discs -->
      <radialGradient id="pl-warm">
        <stop offset="0" stop-color="var(--plane-warm)" stop-opacity=".95"/>
        <stop offset=".32" stop-color="var(--plane-warm)" stop-opacity=".62"/>
        <stop offset=".58" stop-color="var(--plane-warm)" stop-opacity=".30"/>
        <stop offset=".80" stop-color="var(--plane-warm)" stop-opacity=".10"/>
        <stop offset="1" stop-color="var(--plane-warm)" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="pl-cool">
        <stop offset="0" stop-color="var(--plane-cool)" stop-opacity=".9"/>
        <stop offset=".38" stop-color="var(--plane-cool)" stop-opacity=".52"/>
        <stop offset=".66" stop-color="var(--plane-cool)" stop-opacity=".22"/>
        <stop offset=".85" stop-color="var(--plane-cool)" stop-opacity=".07"/>
        <stop offset="1" stop-color="var(--plane-cool)" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="pl-dust">
        <stop offset="0" stop-color="var(--plane-dust)" stop-opacity=".92"/>
        <stop offset=".45" stop-color="var(--plane-dust)" stop-opacity=".58"/>
        <stop offset=".78" stop-color="var(--plane-dust)" stop-opacity=".18"/>
        <stop offset="1" stop-color="var(--plane-dust)" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <g id="pcam" class="cam">
      <g id="pdrift">
        <g id="p-glow"></g>
        <g id="p-stars" fill="var(--plane-star)"></g>
        <g id="p-dust"></g>
      </g>
    </g>
  </svg>
</div>
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g id="cam-far" class="cam"><g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g></g>
    <g id="cam-near" class="cam"><g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g></g>
  </svg>
  <!-- §15/#480, retrograde only: the walls. The dial view carries no grid at
       all — no floor, no ceiling, no horizon air — and these two side planes
       are the whole of the room, arriving from the sides only once the reader
       descends to the manifest. The .ceiling div that used to sit here left
       with its rules. Inert in every other pack. -->
  <div class="wall wl" aria-hidden="true"></div>
  <div class="wall wr" aria-hidden="true"></div>
</div>
<div class="vignette" aria-hidden="true"></div>
<!-- DAWN — THE TERMINATOR. Three layers the crossing is painted on, all of
     them written by sky-terminator.js against this window: the night wash, the
     starlight field masked to exactly the night side of the handover, and the
     limb — the thin warm air the light reaches first, which is what keeps the
     dial's own chart ink lifted where the crossing passes through it. -->
<div class="night" id="night" aria-hidden="true"></div>
<div class="nightsky" id="nightsky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g id="tcam-far" class="cam"><g id="t-far" fill="var(--night-far)"></g></g>
    <g id="tcam-near" class="cam"><g id="t-near" fill="var(--night-near)"></g></g>
  </svg>
</div>
<div class="tline" id="tline" aria-hidden="true"></div>
<!-- CLOUDS — THE CLOUD SEA. First light seen from altitude: three strata of
     cloud low across the screen, cool at the crest and rose-amber underneath
     where the light is arriving, one or two distant peaks standing out of it.
     The peaks stand out of the MID bank with the far bank behind them — the
     only stacking in which a distant summit is legible, and also the true one,
     because cloud lies both sides of a hill. Streamed by sky-cloudsea.js. -->
<div class="weather" id="weather" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <!-- one softness per depth: the far bank has more air in front of it -->
      <filter id="cs-b0" x="-8%" y="-60%" width="116%" height="260%">
        <feGaussianBlur stdDeviation="5.5"/></filter>
      <filter id="cs-b1" x="-8%" y="-60%" width="116%" height="260%">
        <feGaussianBlur stdDeviation="4"/></filter>
      <filter id="cs-b2" x="-8%" y="-60%" width="116%" height="260%">
        <feGaussianBlur stdDeviation="2.8"/></filter>
      <filter id="cs-peak" x="-30%" y="-40%" width="160%" height="200%">
        <feGaussianBlur stdDeviation="1.9"/></filter>
      <!-- the light is under the cloud, so every stratum runs cool-white at
           the crest into rose-amber in the sixty pixels below it, then into
           the shadow that separates it from the stratum in front -->
      <linearGradient id="cs-g0" gradientUnits="userSpaceOnUse" x1="0" y1="662" x2="0" y2="900">
        <stop offset="0"   stop-color="#eef2f9"/><stop offset=".22" stop-color="#f6e5d5"/>
        <stop offset=".56" stop-color="#eccdb4"/><stop offset="1" stop-color="#e3c0a6"/>
      </linearGradient>
      <linearGradient id="cs-g1" gradientUnits="userSpaceOnUse" x1="0" y1="746" x2="0" y2="1000">
        <stop offset="0"   stop-color="#f4f7fd"/><stop offset=".20" stop-color="#fadec5"/>
        <stop offset=".52" stop-color="#eebd9d"/><stop offset="1" stop-color="#dbab88"/>
      </linearGradient>
      <!-- a distant peak is not a silhouette all the way down: the air
           between you and it thickens toward the cloud it stands in -->
      <linearGradient id="cs-rock" gradientUnits="userSpaceOnUse" x1="0" y1="600" x2="0" y2="805">
        <stop offset="0" stop-color="#5b6889" stop-opacity="1"/>
        <stop offset=".52" stop-color="#6e7b9e" stop-opacity=".50"/>
        <stop offset="1" stop-color="#8f9cbe" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="cs-rim" gradientUnits="userSpaceOnUse" x1="0" y1="600" x2="0" y2="790">
        <stop offset="0" stop-color="#ffcd96" stop-opacity=".95"/>
        <stop offset=".58" stop-color="#ffb96f" stop-opacity=".42"/>
        <stop offset="1" stop-color="#ffb96f" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="cs-g2" gradientUnits="userSpaceOnUse" x1="0" y1="826" x2="0" y2="1090">
        <stop offset="0"   stop-color="#faf7f5"/><stop offset=".18" stop-color="#fbd5ab"/>
        <stop offset=".50" stop-color="#e9aa83"/><stop offset="1" stop-color="#cf9370"/>
      </linearGradient>
    </defs>
    <g id="cs-s0" filter="url(#cs-b0)" fill="url(#cs-g0)" opacity=".70"></g>
    <g id="cs-peaks"></g>
    <g id="cs-s1" filter="url(#cs-b1)" fill="url(#cs-g1)" opacity=".90"></g>
    <g id="cs-s2" filter="url(#cs-b2)" fill="url(#cs-g2)" opacity="1"></g>
  </svg>
</div>
<!-- THE THREE DESCENTS' OWN GROUNDS. Each is display:none until its pack is up
     AND the scrollbar is off the top, so at the dial none of them merely
     measures zero — none of them exists. dawn drops onto warm SURFACE light;
     clouds goes through the deck (the MIST of being inside it, then the flat
     blue light that got UNDER it, then the slow loss of height); after dark's
     DEEP closes in behind the departing river, its foot carrying the glow the
     owner asked for, coming back from below the frame. -->
<div class="surface" id="surface" aria-hidden="true"></div>
<div class="mist" aria-hidden="true"></div>
<div class="underlight" aria-hidden="true"></div>
<div class="underdeep" aria-hidden="true"></div>
<div class="deep" aria-hidden="true"></div>
<div class="meteor" style="top:12%;left:18%" aria-hidden="true" data-polish="POL-8"></div>
<div class="meteor m2" aria-hidden="true" data-polish="POL-8"></div>
<div class="meteor m3" aria-hidden="true" data-polish="POL-10"></div>

<!-- §14/#472 (owner-approved): the inbox one click from home — the colour
     change IS the notification, and the count is real (§12). -->
<a class="orb inbox-orb" class:waiting={mailWaiting > 0} href={resolve("/inbox")}
   title={mailWaiting > 0 ? `Inbox — ${mailWaiting} waiting` : "Inbox"}
   aria-label={mailWaiting > 0 ? `Inbox — ${mailWaiting} waiting` : "Inbox"}>
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle cx="9" cy="11" r="2.6" fill="currentColor"/>
    <path d="M 3 11 A 6 6 0 0 1 15 11" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".65"/>
    <path d="M 5.4 11 A 3.6 3.6 0 0 1 12.6 11" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".85"/>
  </svg>
  {#if mailWaiting > 0}<i class="count">{mailWaiting}</i>{/if}
</a>
<button class="orb" aria-expanded="false" aria-controls="account" title="Menu" onclick={readyDescent}>{initials}</button>
<div class="account" id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>{view?.user?.displayName ?? ""}</b><span id="who-role"
    >{view ? `${view.household?.name ?? ""} · ${view.galaxy[/** @type {string} */ (view.primary)]?.role ?? "member"}` : ""}</span></div>
  <nav>
    <a href={resolve("/inbox")}>Inbox</a>
    <a href={resolve("/settings")}>Settings</a>
    <a href={resolve("/administration")}>Administration</a>
    <a href={resolve("/about")}>About</a>
  </nav>
  <div class="swatches" role="group" aria-label="Theme">
    <span>THEME</span>
    <button style="background:#070d1f" title="star-chart" aria-pressed="true"></button>
    <button style="background:#05070d" title="after dark" aria-pressed="false"></button>
    <!-- THE v1.3.0 ROSTER, FINAL (§15, owner): five packs, five swatches.
         CLOUDS joins as its own selectable pack, carrying the lighter end of
         the range; dawn's dot follows its ground onto the temperature story.
         Atlas, hanami, porcelain, miami and solarium are on the records shelf —
         their packs still exist in packs.css and still render if forced, but
         they are no longer offered. -->
    <button style="background:#eef2f9" title="clouds" aria-pressed="false"></button>
    <button style="background:#d2d3d4" title="dawn" aria-pressed="false"></button>
    <button style="background:#080a14;box-shadow:inset 0 0 0 1px #ff4fd8" title="retrograde"
            aria-pressed="false"></button>
  </div>
  <!-- "Watch the tour" (#1189), beside the theme as in every account menu.
       The card closes the way home.behaviour.js's closeOverlays closes it,
       so the film opens over the sky rather than under the card. -->
  <button class="watch" onclick={() => { closeAccount(); void watchTour(); }}>↻ watch the tour</button>
  <!-- One press to leave, and it revokes the session before a
       single frame of the descent is drawn (§15: logout is the login played
       backwards, and it is a real sign-out, not an animation about one). -->
  <button class="signout" onclick={tapSignOut} disabled={signingOut}>
    sign out →
  </button>
  {#if signOutProblem}<div class="signout-problem">{signOutProblem}</div>{/if}
</div>

<!-- CON-12: creation drawer — full width, from the top; the north star is its handle -->
<aside class="drawer-top" id="createdrawer" role="region" aria-label="Add to your orbit">
  <!-- the handle comes first in the markup so that Tab from an opened
       north star walks into the drawer's own controls next (#853); it is
       positioned absolutely, so this changes nothing on screen. -->
  <button class="nstar" id="nstar" aria-expanded="false" title="Add to your orbit">
    <NorthStarMark />
    <span>create</span>
  </button>
  <div class="inner">
    <h2>Add to your orbit</h2>
    <div class="ctypes">
      <button class="ctype"><span class="dot con"></span>renewal</button>
      <button class="ctype"><span class="dot"></span>service</button>
      <button class="ctype"><span class="dot ter"></span>inspection</button>
      <button class="ctype"><span class="dot" style="background:none;border:1.6px solid currentColor"></span>something else</button>
    </div>
    <div class="crow">
      <!-- #1243: a real drop target, and a button that opens the file
           picker; either way the file goes to the full form, which reads it. -->
      <div class="cdrop" id="cdrop" role="button" tabindex="0" aria-label="drop a document, or press enter to choose one">drop a document here — we'll read what we can</div>
      <a class="cfull" href={resolve("/create")}>open the full form →</a>
    </div>
  </div>
</aside>

<div class="scrim" aria-hidden="true"></div>
<div class="page">
    <div class="hero" id="hero">
    {#if view?.emptySky}
    <!-- §11 (#453): the labelled sky — no dial, no manifest. The
         constellations are placed by mountEmptySky; this is the hero's
         quiet centre, and the north star above still creates. -->
    <div class="adrift">
      <h2>you’re adrift</h2>
      <p>the systems around you are labels until someone lets you in —<br>
         tap one to ask to join, or follow the north star to start your own</p>
    </div>
    {:else}
    <!-- #1161 (BUILD.md §2): the body-drawing chain lifted out of the dial's
         own each-block so the strip below can draw the same matched planet
         from the same tokens — never a second painting of the same body.
         (b, cx, cy, r) rather than reading b.placement/b.size directly: the
         strip's r is 1.1× the dial's own size, not the dial's own centre. -->
    {#snippet bodyMark(b = EMPTY_BODY, cx = 0, cy = 0, r = 0)}
      {#if b.suggestion}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--accent)" stroke-width="1.6"/>
      {:else if b.kind === "expiry"}
        <!-- #1005: no fill, no core, no highlight -- the ring IS the body. -->
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={expiryStroke(b)} stroke-width="2" stroke-dasharray="2.6 2.2"/>
      {:else if b.paint === "ruby" || b.paint === "amber"}
        <circle cx={cx} cy={cy} r={r} style="stroke:var(--bg);stroke-width:2" fill="url(#p-{b.paint})"/>
      {:else if b.paint === "sky"}
        <circle cx={cx} cy={cy} r={r} style="stroke:var(--upcoming);stroke-opacity:.25;stroke-width:2.6" fill="url(#p-sky)"/>
      {:else if b.documentCount > 0}
        <circle cx={cx} cy={cy} r={r} style="stroke:var(--ok);stroke-opacity:.25;stroke-width:3" fill="url(#p-jade)"/>
      {:else}
        <circle cx={cx} cy={cy} r={r} fill="url(#p-jade)"/>
      {/if}
      {#if !b.suggestion && b.kind === "inspection"}
        <path d="M {cx} {cy - r} A {r} {r} 0 0 1 {cx} {cy + r} Z" fill="rgba(0,0,0,.42)"/>
      {/if}
      {#if !b.suggestion && b.kind === "renewal"}
        <circle cx={cx} cy={cy} r={r * 0.57} style="fill:var(--bg)"/>
        <circle cx={cx} cy={cy} r={r * 0.28} fill="url(#p-{b.paint})"/>
      {/if}
      {#if !b.suggestion && b.kind !== "expiry" && r >= 4}
        <circle cx={cx - 0.2 * r} cy={cy + 0.25 * r} r={0.33 * r} fill="rgba(255,255,255,.38)"/>
      {/if}
    {/snippet}
    <!-- backdrop constellations are generated from the galaxy map -->
    <div class="dialwrap">
      <svg width="640" height="640" class="dial" viewBox="0 0 380 380" role="group"
         aria-label="Gravity well: items orbit by due date; distance from the household is time remaining, body size is typical cost; details in the manifest below">
      <defs aria-hidden="true">
        <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4"/>
        </filter>
        <radialGradient id="p-ruby" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-ruby-1, #ffb3ab)"/><stop offset="42%" stop-color="var(--p-ruby-2, #e0453e)"/>
          <stop offset="100%" stop-color="var(--p-ruby-3, #7e1a1f)"/>
        </radialGradient>
        <radialGradient id="p-jade" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-jade-1, #b8f5cf)"/><stop offset="45%" stop-color="var(--p-jade-2, #2fae6a)"/>
          <stop offset="100%" stop-color="var(--p-jade-3, #12603a)"/>
        </radialGradient>
        <radialGradient id="p-amber" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-amber-1, #ffe1a0)"/><stop offset="45%" stop-color="var(--p-amber-2, #f0a52b)"/>
          <stop offset="100%" stop-color="var(--p-amber-3, #8a5a10)"/>
        </radialGradient>
        <radialGradient id="p-sky" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-sky-1, #cfe4ff)"/><stop offset="45%" stop-color="var(--p-sky-2, #6fa3ef)"/>
          <stop offset="100%" stop-color="var(--p-sky-3, #2a4f8f)"/>
        </radialGradient>
        <radialGradient id="danger4" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#f87171" stop-opacity=".10"/>
          <stop offset="55%" stop-color="#f87171" stop-opacity=".035"/>
          <stop offset="85%" stop-color="#f87171" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <g class="chrome" aria-hidden="true">
      <g class="celestial rotor">
        <g stroke="var(--chart-line-soft)" stroke-width=".5">
          <line x1="190" y1="14" x2="190" y2="34"/><line x1="314.5" y1="65.5" x2="300" y2="80"/>
          <line x1="366" y1="190" x2="346" y2="190"/><line x1="314.5" y1="314.5" x2="300" y2="300"/>
          <line x1="190" y1="366" x2="190" y2="346"/><line x1="65.5" y1="314.5" x2="80" y2="300"/>
          <line x1="14" y1="190" x2="34" y2="190"/><line x1="65.5" y1="65.5" x2="80" y2="80"/>
        </g>
        <circle cx="190" cy="190" r="168" fill="none" stroke="var(--chart-line-soft)" stroke-width=".5"/>
      </g>
      <g class="celestial">
        <polyline points={constellationPoints} fill="none"
                  stroke="var(--accent)" stroke-opacity=".38" stroke-width="1"
                  stroke-dasharray="1 5" stroke-linecap="round"/>
      </g>

      <circle cx="190" cy="190" r="62" fill="url(#danger4)"/>
      <circle cx="190" cy="190" r="62" fill="none" stroke="var(--overdue)"
              stroke-opacity=".3" stroke-width="1" stroke-dasharray="3 5"/>
      <circle cx="190" cy="190" r="106" fill="none" stroke="var(--chart-line-soft)" stroke-width=".75"/>
      <circle cx="190" cy="190" r="150" fill="none" stroke="var(--chart-line)" stroke-width="1.5"/>

      <g stroke="var(--chart-line)" stroke-width="1.5">
        <line x1="190" y1="40" x2="190" y2="47"/><line x1="265" y1="60.1" x2="261.5" y2="66.2"/>
        <line x1="319.9" y1="115" x2="313.8" y2="118.5"/><line x1="340" y1="190" x2="333" y2="190"/>
        <line x1="319.9" y1="265" x2="313.8" y2="261.5"/><line x1="265" y1="319.9" x2="261.5" y2="313.8"/>
        <line x1="190" y1="340" x2="190" y2="333"/><line x1="115" y1="319.9" x2="118.5" y2="313.8"/>
        <line x1="60.1" y1="265" x2="66.2" y2="261.5"/><line x1="40" y1="190" x2="47" y2="190"/>
        <line x1="60.1" y1="115" x2="66.2" y2="118.5"/><line x1="115" y1="60.1" x2="118.5" y2="66.2"/>
      </g>
      <g font-size="9" fill="var(--chart-ink)" text-anchor="middle">
        {#each monthLabels as m, k (k)}
          {#if k === 0}<text x={m.x} y={m.y} class="now-month" data-polish="POL-3">{m.label}</text>
          {:else}<text x={m.x} y={m.y}>{m.label}</text>{/if}
        {/each}
      </g>

      <path d="M190 38 l5.5 9 h-11 Z" style="fill:var(--accent)"/>

      <g fill="none" stroke-linecap="round">
        {#each trailed as b (b.id)}
          <path d={trailPath(b)} stroke={trailStroke(b)}
                stroke-opacity={b.suggestion ? ".45" : ".5"} stroke-width="2"/>
        {/each}
      </g>

      {#if closest}
        <line data-polish="POL-7" id="comet" class="comet"
              x1={closest.placement.x} y1={closest.placement.y}
              x2={closest.placement.x + 28.2} y2={closest.placement.y - 99.7}
              stroke-dasharray="110" stroke-dashoffset="110"/>
      {/if}
      </g><!-- /chrome -->
      <!-- §15, the 08-17 morning batch (owner): "we should be able to click the
           sun in the centre of the dial and go to the given household's view."
           The sun and the name written under it are ONE identity — the sun IS
           this household — so they are one hit target, not two.

           A link, not a handler, for the reason the helm's memberships card
           states (§15-2k): it is a place, so it wants an address the browser
           can open in its own way — focusable and Enter-activated for free, a
           new tab on a modified click, and on touch a single tap. CON-5's
           two-tap belongs to the bodies because a finger cannot hover a
           callout out of them; the sun has no callout to summon — it wears its
           name permanently, which is everything a callout would have said — so
           there is no first beat to spend and the first tap approaches.

           No id, no link: before the household arrives (and on the labelled
           sky's dial-less hero) there is nothing to point at, and an <a>
           without an href is honestly inert rather than a dead target. -->
      <!-- §15, owner 2026-08-17: the household screen's way back is the way you
           came, so the sun says which door it is as the reader steps through.
           A one-shot marker, read and deleted on arrival (door.js) — an <a>
           keeps every behaviour it has, because this only writes. -->
      <a class="sun-link" href={view?.primary ? resolve("/household/[id]", { id: encodeURIComponent(view.primary) }) : undefined}
         onclick={() => markDoor("sky")}
         aria-label={view?.household?.name ? `Open ${view.household.name}` : undefined}>
        <!-- #1250: the sun itself is drawn by the layer over the dial (Sun.svelte,
             Furnace); this is its disc, kept in the link as what a pointer lands on -->
        <circle class="sun-disc" cx="190" cy="190" r={SUN_R} fill="transparent"/>
        <text id="dial-name" x="190" y="212" font-size="10" fill="var(--ink-mid)" text-anchor="middle" style="font-family:var(--ui)">{view?.household?.name ?? ""}</text>
      </a>

      {#if firstOverdue}
        <circle data-polish="POL-2" class="ping" cx={firstOverdue.placement.x} cy={firstOverdue.placement.y}
                r="8" fill="none" style="stroke:var(--overdue)"/>
      {/if}
      {#each bodies as b (b.id)}
        {#if b.suggestion}
          <a class="body-link" data-body={b.id} data-title={b.title} data-t={tlabel(b)}
             data-cost={money(b.costMinor, b.currency, true)} href="#{b.id}"
             aria-label={`suggested: ${b.title}, ${tlabel(b)} · ${money(b.costMinor, b.currency, true)}`}><g
            ><circle cx={b.placement.x} cy={b.placement.y} r={b.size + 1.2}
                     style="fill:none;stroke:var(--accent);stroke-width:1.8"
            /><circle cx={b.placement.x} cy={b.placement.y} r={b.size - 1.3}
                     style="fill:var(--accent)" opacity=".12"/></g></a>
        {:else}
          <a class="body-link" data-body={b.id} data-title={b.title} data-t={tlabel(b)}
             data-cost={money(b.costMinor, b.currency, b.costIsEstimate)}
             data-docs={b.documentCount > 0 ? b.documentCount : undefined} href="#{b.id}"
             aria-label={`${b.title}, ${tlabel(b)} · ${money(b.costMinor, b.currency, b.costIsEstimate)}${b.documentCount > 0 ? `, ${b.documentCount} document${b.documentCount === 1 ? "" : "s"}` : ""}`}><g
             id={b.closest ? "b-closest" : undefined}
             class={b.overdue || b.paint === "amber" ? "breathe" : undefined}>
            {@render bodyMark(b, b.placement.x, b.placement.y, b.size)}
          </g></a>
        {/if}
      {/each}
      {#each bodies.filter((b) => b.documentCount > 0 && b.paint === "jade") as b (b.id)}
        <g class="belt" aria-hidden="true">
          <ellipse cx={b.placement.x} cy={b.placement.y} rx="13.5" ry="4.6"
                   transform="rotate(-24 {b.placement.x} {b.placement.y})"
                   fill="none" style="stroke:var(--accent)" stroke-width="1.3" opacity=".8"/>
        </g>
      {/each}
    </svg>
    <Sun r={SUN_R} />
    </div>
    <div class="hero-foot">
      <div class="splash-search" style="position:relative">
        <!-- #1161, "C · unrolled" (design/v19/search/round-1/BUILD.md): the
             year drawn as a line above the field, replacing POL-9's command
             palette. aria-hidden — #explore-results below is the accessible
             read of the same results; the SVG is decoration. -->
        <div class="strip" id="strip" aria-hidden="true" class:open={stripOpen}>
          <svg id="stripsvg" width="820" height="150" viewBox="0 0 820 150">
            {#if stripOpen}
              <line class="past" x1={AXIS_X0} y1={AXIS_Y} x2={stripTodayX} y2={AXIS_Y}/>
              <line class="axis" x1={stripTodayX} y1={AXIS_Y} x2={AXIS_X1} y2={AXIS_Y}/>
              {#each stripMonthTicks as t (t.days)}
                <line class="tick" x1={t.x} y1={AXIS_Y - 3} x2={t.x} y2={AXIS_Y + 3}/>
                {#if !stripBusyX.some((bx) => Math.abs(bx - t.x) < 16)}
                  <text class="month" x={t.x} y={AXIS_Y + 16} text-anchor="middle">{t.name}</text>
                {/if}
              {/each}
              <path class="today" d="M{stripTodayX} {AXIS_Y + 4} l4.5 8 h-9 Z" style="fill:var(--accent)"/>
              {#each stripMarks as m (m.itemId)}
                <g class="match" class:sel={isMarkSelected(m)}
                   role="presentation"
                   onmouseenter={() => selectMark(m)}
                   onmousedown={(event) => { event.preventDefault(); openMark(m); }}>
                  {#if isMarkSelected(m)}
                    <circle class="halo" cx={m.x} cy={AXIS_Y} r={m.r + 4} style="stroke:var(--accent)"/>
                  {/if}
                  {#if !m.unscheduled}
                    <path class="lead" d={m.leaderPath} style={isMarkSelected(m) ? "stroke:var(--accent);stroke-opacity:.85" : undefined}/>
                  {/if}
                  {#if m.showLabel}
                    {#each m.lineNodes as line, i (i)}
                      <text class={line.cls} x={m.anchorX} text-anchor={m.flip ? "end" : undefined} y={line.y}>{line.text}</text>
                    {/each}
                  {/if}
                  {#if !m.unscheduled}
                    {@render bodyMark(m.body ?? EMPTY_BODY, m.x, AXIS_Y, m.r)}
                  {/if}
                </g>
              {/each}
            {/if}
          </svg>
          <div class="strip-note" id="strip-note">
            {#if !searchQuery}
              {#each stripActs as a, i (a.itemId)}
                {#if i > 0}<span class="sep">·</span>{/if}
                <span class="act" role="presentation"
                      onmousedown={(event) => { event.preventDefault(); selectAct(a); fireAct(a); }}
                      >{a.kind === "complete" && completeArmed ? a.title : `→ ${a.title}`}</span>
              {/each}
              {#if stripProblem}<span class="sep">·</span><span style="color:var(--overdue)">{stripProblem}</span>{/if}
            {:else if searchResults.nothing}
              <span>nothing in your orbit is called "{searchResults.query}"</span>
              <span class="sep">·</span>
              {#each stripActs as a (a.itemId)}
                <span class="act" role="presentation"
                      onmousedown={(event) => { event.preventDefault(); selectAct(a); fireAct(a); }}
                      >→ {a.title}</span>
              {/each}
            {:else}
              <span>{searchResults.items.length} in your orbit</span>
              {#if searchResults.documents.length}
                <span class="sep">·</span>
                <span>{searchResults.documents.length} document{searchResults.documents.length === 1 ? "" : "s"}</span>
              {/if}
              <span class="sep">·</span>
              <span class="hint">←→ step · ↵ open</span>
            {/if}
          </div>
        </div>
        <input id="explore" placeholder="explore your world" aria-label="Search items and documents"
               autocomplete="off" bind:value={searchQuery} role="combobox" aria-expanded={stripOpen}
               aria-controls="explore-results" aria-autocomplete="list"
               aria-activedescendant={!stripOpen || selectedPos === null ? undefined : `sr-opt-${selectedPos}`}
               onfocus={onExploreFocus} onblur={onExploreBlur}
               oninput={() => { selectedIndex = 0; stripProblem = null; }}
               onkeydown={onExploreKeydown}>
        {#if stripOpen}
          <ul class="sr-only" id="explore-results" role="listbox" aria-label="Results">
            {#each selectable as entry, i (i)}
              <li id="sr-opt-{i}" role="option" aria-selected={i === selectedPos}>
                {entry.kind === "item" ? `${entry.title} · ${tlabel({ days: entry.days })}`
                  : entry.kind === "doc" ? `document ${entry.title} · ${entry.itemTitle}`
                  : entry.title}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
    {/if}
  </div>

    <!-- §14 (#469): ONE schedule surface. The manifest IS the corridor — a
         full scrollback through events, nearest at the top down to the
         furthest away, suggestions riding the same line in date order. -->
    <div class="manifest" id="manifest-top" bind:this={manifestEl}
         style:max-width={pair ? `${pair.maxWidth}px` : undefined}
         style:transform={pair ? `translateX(${pair.shift}px)` : undefined}>
    {#if corridor && !view?.emptySky}
      <div class="corridor">
        {#if corridor.overdue.length}
          <div class="redzone">
            {#each corridor.overdue as row (row.id)}
              <CorridorRow {row} {suggestions} {busyReceipt} {armed} {mailProblem} {today} {expanded}
                onReceiptTap={tapReceipt} {onRowClick} {detail} {detailBusy} {detailProblem} {copied}
                onCopyAddress={copyAddress} showingDoc={previewDoc?.id ?? null} onOpenDoc={openDoc} acts={drawerActs} />
            {/each}
          </div>
        {/if}
        <div class="today"><span class="sunmark" aria-hidden="true"><i></i><b></b></span><span>TODAY · {todayLine}</span><div class="rule"></div></div>
        {#each corridor.current as row (row.id)}
          <CorridorRow {row} {suggestions} {busyReceipt} {armed} {mailProblem} {today} {expanded}
            onReceiptTap={tapReceipt} {onRowClick} {detail} {detailBusy} {detailProblem} {copied}
            onCopyAddress={copyAddress} showingDoc={previewDoc?.id ?? null} onOpenDoc={openDoc} acts={drawerActs} />
        {/each}
        {#each corridor.months as month (month.key)}
          <div class="month"><span>{month.label}</span><div class="rule"></div><small>{month.rows.length} approaching</small></div>
          {#each month.rows as row (row.id)}
            <CorridorRow {row} {suggestions} {busyReceipt} {armed} {mailProblem} {today} {expanded}
              onReceiptTap={tapReceipt} {onRowClick} {detail} {detailBusy} {detailProblem} {copied}
              onCopyAddress={copyAddress} showingDoc={previewDoc?.id ?? null} onOpenDoc={openDoc} acts={drawerActs} />
          {/each}
        {/each}
        <!-- #1281: what is kept without a date rides at the foot under its
             own quiet rule, after the last month — never on the dial. -->
        {#if corridor.undated.length}
          <div class="month undated"><span>no date</span><div class="rule"></div><small>{corridor.undated.length} kept without a date</small></div>
        {/if}
        {#each corridor.undated as row (row.id)}
          <CorridorRow {row} {suggestions} {busyReceipt} {armed} {mailProblem} {today} {expanded}
            onReceiptTap={tapReceipt} {onRowClick} {detail} {detailBusy} {detailProblem} {copied}
            onCopyAddress={copyAddress} showingDoc={previewDoc?.id ?? null} onOpenDoc={openDoc} acts={drawerActs} />
        {/each}
      </div>
      {#if corridor.total === 0}
        <div class="horizon">— nothing scheduled: your sky is quiet —</div>
      {:else if corridor.horizon}
        <div class="horizon">— beyond the horizon: nothing scheduled past {corridor.horizon} —</div>
      {/if}
    {/if}
    <!-- #1319, round 3 (F): the preview's column beside the open drawer. -->
    <div class="pvtrack" bind:this={trackEl} style:--pv-y="{track.top}px" style:--pv-h="{track.height}px" style:--readw="{readw}px">
      <PreviewCard doc={previewDoc} itemTitle={detail?.title ?? ""} onclose={closeDoc}
                   onremove={removeDoc} onrestore={restoreDoc} />
      <!-- #1319 stage 2 (round 8): the chooser card, in the preview's seat;
           under 1200px it is the bottom sheet -->
      {#if chooserAsk}
        <div class="chseat" class:sheet={!wide} data-chooser-card>
          <ChooserCard ask={chooserAsk} layout={wide ? "beside" : "sheet"} onpick={pickChoice}
                       onclose={() => modes.closeChooser(true)} />
        </div>
      {/if}
    </div>
  </div>
</div>

<aside class="drawer drawer-left" id="statusdrawer" role="region" aria-live="polite" aria-label="System status">
  <button class="handle" id="edge-health" aria-expanded="false">
    <i></i><span>{systemStatus?.handle ?? "unknown"}</span></button>
  <h2>System status</h2>
  {#each systemStatus?.services ?? [] as row (row.service)}
    <div class="svc"><i style="background:{statusDot(row.state)}"></i><b>{row.service}</b><small>{statusWord(row.state)}{#if observedLabel(row)} &middot; {observedLabel(row)}{/if}</small></div>
  {/each}
  {#if systemStatus?.lastCheck}
    <h2>Last health check</h2>
    {#if systemStatus.lastCheck.scan}
      <div class="svc"><i style="background:{statusDot(systemStatus.lastCheck.scan)}"></i><b>scan readiness</b><small>{statusWord(systemStatus.lastCheck.scan)}</small></div>
    {/if}
    <div class="svc"><i style="background:{statusDot(systemStatus.lastCheck.application)}"></i><b>application</b><small>{statusWord(systemStatus.lastCheck.application)}</small></div>
  {/if}
</aside>
{#if !view?.emptySky}
<aside class="drawer drawer-right" id="keydrawer" role="region" aria-label="Chart key">
  <button class="handle" aria-expanded="false">
    <i></i><span>key</span></button>
  <h2>Urgency</h2>
  <div class="keyrow"><span class="sw" style="background:var(--overdue)"></span>overdue &mdash; inside the ring</div>
  <div class="keyrow"><span class="sw" style="background:var(--warm)"></span>due soon</div>
  <div class="keyrow"><span class="sw" style="background:var(--upcoming)"></span>upcoming</div>
  <div class="keyrow"><span class="sw" style="background:var(--ok)"></span>on track &mdash; wide orbit</div>
  <h2>Types</h2>
  <div class="keyrow"><span class="sw" style="background:var(--ink-mid)"></span>routine service</div>
  <div class="keyrow"><span class="sw" style="background:radial-gradient(circle,var(--ink-mid) 24%,var(--panel-raised) 34%,var(--ink-mid) 52%)"></span>renewal / contract</div>
  <div class="keyrow"><span class="sw" style="background:none;border:2px dashed var(--ink-mid)"></span>expiry &mdash; ends, does not come round</div>
  <div class="keyrow"><span class="sw" style="background:linear-gradient(90deg,var(--ink-mid) 50%,rgba(0,0,0,.55) 50%)"></span>inspection / certification</div>
  <div class="keyrow"><span class="sw" style="background:none;border:1.6px solid var(--accent)"></span>suggestion &mdash; not yet accepted</div>
  <h2>Physics</h2>
  <div class="keyrow">closer = sooner</div>
  <div class="keyrow">bigger = costlier</div>
  <div class="keyrow">belt = documents attached</div>
  <div class="keyrow">the sky&rsquo;s weather = your workload</div>
</aside>
{/if}
{#if askTarget}
<!-- §11 (#453): the question IS the dialogue — one ask, two honest answers. -->
<div class="askveil" role="dialog" aria-label="Request to join">
  <div class="askcard">
    <h3>Request to join {askTarget.name} system?</h3>
    <p>its owners decide — you’ll see the whole system once someone lets you in</p>
    {#if askProblem}<div class="askproblem">{askProblem}</div>{/if}
    <div class="askacts">
      <button class="yes" disabled={askBusy} onclick={ask}>request to join</button>
      <button disabled={askBusy} onclick={() => (askTarget = null)}>not now</button>
    </div>
  </div>
</div>
{/if}
</div>
