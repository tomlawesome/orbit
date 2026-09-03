<script>
  import { onMount, tick } from "svelte";
  import { browser } from "$app/environment";
  import { afterNavigate, pushState, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { mountEmptySky, mountHome } from "./home.behaviour.js";
  import Flight from "$lib/flight/Flight.svelte";
  import Dawn from "$lib/flight/Dawn.svelte";
  import Dusk from "$lib/flight/Dusk.svelte";
  import { consumeLaunch } from "$lib/flight/arrival.js";
  /* The sun is one of the household screen's two doors, and that screen owns
     the marker both doors speak through (§15, owner 2026-08-17). */
  import { markDoor } from "../household/[id]/door.js";
  import { approveReceipt, dismissReceipt, readHome, readItem, requestToJoin, signOut } from "$lib/data/workspace.js";
  import { corridorOf, dialBodiesOf, manifestGroupsOf } from "$lib/data/chart.js";
  import { every, longDate, money, tminus } from "$lib/format.js";
  import Pocket from "./pocket.svelte";
  import { mountPocket } from "./pocket.behaviour.js";
  import { SvelteMap } from "svelte/reactivity";
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

  /** @type {import('$lib/data/workspace.js').HomeView | null} */
  let view = $state(null);

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
  let { data } = $props();
  /* The fixture harness (see +page.server.js): drives either journey to one
     millisecond and holds it there. Off unless the server says ORBIT_FIXTURES,
     so the query string is inert in the product. */
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
    if (launching && !fixtureFlight) flight?.ascend();
  });
  async function driveFixture() {
    if (!fixtureFlight) return;
    await tick();
    if (fixtureFlight === "up") flight?.ascend({ at: fixtureAt });
    else if (fixtureFlight === "down") {
      /* the descent leaves from a settled arrival, so it starts from one */
      document.body.classList.add("instrument");
      await tick();
      flight?.descend({ at: fixtureAt });
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
  let flight = $state(null);
  let leaving = $state(fixtureFlight === "down");
  let armedOut = $state(false);
  let signOutProblem = $state(null);

  async function tapSignOut() {
    /* Two taps, as every destructive control in this app arms and fires. */
    if (!armedOut) { armedOut = true; return; }
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
      armedOut = false;
      signOutProblem = error?.message ?? "still signed in — try again";
      return;
    }
    providerLogout = redirectTo;
    leaving = true;
    await tick();
    flight?.descend();
  }
  /* The provider's own end-session URL, kept for the way back: following it
     now would yank the reader off the ratified goodbye, so "sign back in"
     carries it instead, and the identity provider asks its question again. */
  /** @type {string | null} */
  let providerLogout = $state(null);
  const backIn = $derived(providerLogout ?? "/");

  function onFarewell() {
    /*
     * The address catches up with the state. The descent plays over home, but
     * the reader is signed out when it ends, and /home is no longer theirs: a
     * refresh here would bounce them at the identity provider instead of
     * showing them the goodbye. Replace, never push — Back must not walk into
     * a signed-out /home either.
     */
    try { history.replaceState(history.state, "", "/logout"); } catch { /* no history, no harm */ }
  }
  export const snapshot = {
    capture: () => window.scrollY,
    restore: (y) => { restoreScroll = y; },
  };

  /* Mail-in review on the row (#434): first tap arms, second fires. One
     operation id per receipt across every retry — approval is idempotent by
     construction, so a double-tap can never create two items. */
  let armed = $state({ id: null, act: null });
  let busyReceipt = $state(null);
  let mailProblem = $state(null);

  /* §11 (#453): the ask prompt — the label is the whole surface, the
     question is the whole dialogue. Idempotent server-side. */
  let askTarget = $state(null);
  let askBusy = $state(false);
  let askProblem = $state(null);
  let resync = () => {};
  async function ask() {
    askBusy = true;
    askProblem = null;
    try {
      await requestToJoin(askTarget.id);
      askTarget = null;
      view = await readHome();
      await tick();
      resync();
    } catch (error) {
      askProblem = error?.message ?? String(error);
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
  const addressOf = (id) => `/home?item=${encodeURIComponent(id)}`;
  const expanded = $derived(page.state.orbitItem ?? null);
  /* True only while the open row owns a history entry we pushed ourselves —
     the difference between closing by going back and closing by rewriting the
     address of a deep link. */
  let pushedEntry = false;
  let detail = $state(null);
  let detailBusy = $state(false);
  let detailProblem = $state(null);
  let copied = $state(false);
  let detailFor = null;
  let revealTarget = null;

  $effect(() => {
    const id = expanded;
    if (!id) {
      pushedEntry = false;
      detailFor = null;
      detail = null;
      detailProblem = null;
      return;
    }
    if (detailFor === id) return;
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
        /* A row opened FROM the address is put on screen twice: once as soon
           as it opens, and again once the detail has given it its full height
           — otherwise the record you asked for settles half off the bottom. */
        if (revealTarget !== id) return;
        revealTarget = null;
        await tick();
        document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "auto" });
      })
      .catch((error) => {
        if (detailFor === id) detailProblem = error?.message ?? String(error);
      })
      .finally(() => {
        if (detailFor === id) detailBusy = false;
      });
  });

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

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(new URL(addressOf(expanded), location.origin).href);
      copied = true;
    } catch {
      /* A refused clipboard is not an error worth a dialogue: the address is
         already in the browser's own bar, which is where it lives. */
      copied = false;
    }
  }

  function onWindowKeydown(event) {
    if (event.key === "Escape" && expanded) collapseRow();
  }
  function onWindowClick(event) {
    if (!expanded) return;
    const target = event.target instanceof Element ? event.target : null;
    /* Inside the open row or its panel: stay. On another expandable row: that
       row's own handler is switching to it. Anywhere else: close. */
    if (target?.closest("a.item, .itemview")) return;
    collapseRow();
  }

  /* Arriving on the address rather than clicking into it: put the row on
     screen and open it, then hand the entry the state it would have had if
     you had clicked, so Forward and Back agree with each other. */
  async function openFromAddress() {
    const id = page.url.searchParams.get("item");
    if (!id || page.state.orbitItem === id) return;
    revealTarget = id;
    replaceState(resolve(`/home?item=${encodeURIComponent(id)}`), { orbitItem: id });
    await tick();
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "auto" });
  }

  const detailDue = (one) =>
    one.dueDate ? `${tminus(one.dueDate, one.today)} · ${longDate(one.dueDate)}` : "unscheduled";

  const operationIds = new SvelteMap();
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
        const result = await approveReceipt(suggestion, view.primary, operationIds.get(suggestion.receiptId));
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
      mailProblem = error?.message ?? String(error);
    } finally {
      busyReceipt = null;
    }
  }

  /* Everything below the chrome is the view-model (#451): the same transform
     the unit tests pin renders the dial, the manifest and the palette. */
  const bodies = $derived(
    view ? dialBodiesOf(view.household, { suggestions: view.suggestions, today: view.today }) : [],
  );
  const groups = $derived(
    view ? manifestGroupsOf(view.household, { suggestions: view.suggestions, today: view.today }) : null,
  );
  /* §14 (#469): the manifest rendered as the corridor — this household's
     full scrollback, suggestions merged in date order. */
  const corridor = $derived(
    view?.household
      ? corridorOf(
          { households: [view.household], activeHouseholdId: view.primary },
          view.today,
          { suggestions: view.suggestions },
        )
      : null,
  );
  const todayLine = $derived(
    view
      ? new Date(view.today + "T00:00:00Z")
          .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
          .replace(",", "").toUpperCase()
      : "",
  );
  /* the inbox orb's truth: arrivals awaiting the two-tap */
  const mailWaiting = $derived(view?.suggestions?.length ?? 0);
  const initials = $derived(
    (view?.user?.displayName ?? "")
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

  const tlabel = (b) => (b.days < 0 ? `T+${-b.days}d` : `T−${b.days}d`);
  const short = (iso) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const period = (months) => (months === 12 ? "1 year" : months === 6 ? "6 months" : `${months} months`);
  const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok" };
  const T_CLASS = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok" };

  const point = (deg, radius) => [
    Math.round((190 + Math.cos((deg * Math.PI) / 180) * radius) * 10) / 10,
    Math.round((190 + Math.sin((deg * Math.PI) / 180) * radius) * 10) / 10,
  ];
  /* A trail rides just behind the body on its own orbit (suggestions: just
     ahead) — the arc the design drew for everything close to the sun. */
  const trailPath = (b) => {
    const angle = b.days - 90;
    const [from, to] = b.suggestion ? [angle + 3, angle + 7] : [angle - 7, angle - 3];
    const [x1, y1] = point(from, b.placement.radius);
    const [x2, y2] = point(to, b.placement.radius);
    return `M ${x1} ${y1} A ${b.placement.radius} ${b.placement.radius} 0 0 1 ${x2} ${y2}`;
  };
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
  const crescent = (b) =>
    `M ${b.placement.x} ${b.placement.y - b.size} A ${b.size} ${b.size} 0 0 1 ${b.placement.x} ${b.placement.y + b.size} Z`;


  onMount(() => {
    const query = window.matchMedia(DESK);
    let teardown = null;
    let disposed = false;
    const sync = () => {
      teardown?.();
      /* §11 (#453): no household means the labelled sky in either dialect —
         same bearings, label only, click to ask. */
      if (view?.emptySky) {
        if (query.matches) {
          teardown = mountEmptySky({ galaxy: view.galaxy, onAsk: (id, name, requested) => { if (!requested) askTarget = { id, name }; } });
        } else {
          /* The pocket's labelled sky is a list; asking rides data attributes
             because the hidden dialect must never bind listeners. */
          const controller = new AbortController();
          for (const row of document.querySelectorAll("[data-ask]")) {
            row.addEventListener("click", () => {
              if (row.dataset.askRequested !== "true") askTarget = { id: row.dataset.ask, name: row.dataset.askName };
            }, { signal: controller.signal });
          }
          teardown = () => controller.abort();
        }
        return;
      }
      /* Tear the old dialect down before standing the new one up. */
      teardown = query.matches
        /* §15, the sky wave: the pack skies are seeded streams, so the fixture
           switch travels with the mount — alive per load in the product, pinned
           to the workspace under ORBIT_FIXTURES, which is what lets the gate
           photograph the same sky twice. */
        ? mountHome({ galaxy: view.galaxy, primary: view.primary,
                      fixtures: Boolean(data?.fixtures), workspace: view.primary ?? "" })
        : mountPocket({
            /* #466: the sheet's two-tap lands on the same idempotent approve
               protocol the desk rows use — one operation id per receipt. */
            approve: (id) => {
              const suggestion = view?.suggestions.find((one) => one.receiptId === id);
              if (suggestion) { armed = { id: suggestion.id, act: "approve" }; tapReceipt(suggestion, "approve"); }
            },
            dismiss: (id) => {
              const suggestion = view?.suggestions.find((one) => one.receiptId === id);
              if (suggestion) { armed = { id: suggestion.id, act: "dismiss" }; tapReceipt(suggestion, "dismiss"); }
            },
          });
    };
    /* The home view comes through the seam, live (#451). onMount must stay
       synchronous — an async callback's return value is discarded, which
       would leak every listener the teardown exists to remove — so the read
       resolves into a closure and mounting follows it, after tick() has put
       the data-driven markup in the document for the behaviour to bind. */
    readHome().then(async (data) => {
      if (disposed) return;
      view = data;
      await tick();
      if (disposed) return;
      sync();
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
    });
    return () => {
      disposed = true;
      query.removeEventListener("change", sync);
      teardown?.();
    };
  });
</script>

<svelte:head>
  <title>Orbit</title>
</svelte:head>

<!-- #424: Escape and a click outside close the expanded row. Scroll does
     NOT — see the note on the law above; that is the one place this parts
     company with §14's drawer rule, deliberately. -->
<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

<Pocket {view} />

<!-- The flight's surfaces: the dawn the climb leaves from, the dusk the
     descent lands on, and the canvas, mark and void-name between them. Each
     is here only for the journey that needs it. -->
{#if launching}<Dawn />{/if}
{#if leaving}
  <Dusk>
    <!-- `backIn` is the identity provider's own end-session URL as often as
         it is "/": genuinely external, not a route this app can resolve(),
         which is what `rel="external"` tells the lint rule (and anyone
         reading the markup) rather than a suppression. -->
    <a class="again" rel="external" href={backIn}>Sign back in</a>
  </Dusk>
{/if}
{#if launching || leaving}
  <Flight bind:this={flight} name={view?.household?.name ?? ""} onfarewell={onFarewell} />
{/if}

<div class="desk" class:arrive>
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
<button class="orb" aria-expanded="false" aria-controls="account" title="Menu">{initials}</button>
<div class="account" id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>{view?.user?.displayName ?? ""}</b><span id="who-role"
    >{view ? `${view.household?.name ?? ""} · ${view.galaxy[view.primary]?.role ?? "member"}` : ""}</span></div>
  <nav>
    <a href={resolve("/inbox")}>Inbox</a>
    <a href={resolve("/settings")}>Settings</a>
    <a href={resolve("/administration")}>Administration</a>
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
  <!-- Two taps to leave, and the second one revokes the session before a
       single frame of the descent is drawn (§15: logout is the login played
       backwards, and it is a real sign-out, not an animation about one). -->
  <button class="signout" onclick={tapSignOut}>
    {armedOut ? "tap again to sign out" : "sign out →"}
  </button>
  {#if signOutProblem}<div class="signout-problem">{signOutProblem}</div>{/if}
</div>

<!-- CON-12: creation drawer — full width, from the top; the north star is its handle -->
<aside class="drawer-top" id="createdrawer" role="region" aria-label="Add to your orbit">
  <div class="inner">
    <h4>Add to your orbit</h4>
    <div class="ctypes">
      <button class="ctype"><span class="dot con"></span>renewal</button>
      <button class="ctype"><span class="dot"></span>service</button>
      <button class="ctype"><span class="dot ter"></span>inspection</button>
      <button class="ctype"><span class="dot" style="background:none;border:1.6px solid currentColor"></span>something else</button>
    </div>
    <div class="crow">
      <div class="cdrop">drop a document here — we'll read what we can</div>
      <a class="cfull" href={resolve("/create")}>open the full form →</a>
    </div>
  </div>
  <button class="nstar" id="nstar" aria-expanded="false" title="Add to your orbit">
    <svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true">
      <defs>
        <linearGradient id="tron-edge" x1="0" y1="-11" x2="0" y2="11" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="var(--upcoming)"/>
          <stop offset=".55" stop-color="var(--upcoming)"/>
          <stop offset="1" stop-color="var(--accent)"/>
        </linearGradient>
      </defs>
      <!-- the mark has THREE forms and only one is ever up: the four-point
           glint every pack has always had, retrograde's neon wireframe beacon
           (§15/#480), and clouds' sounding balloon (§15, the roster ruling:
           "clouds needs ... its own custom symbols"). The pack chooses between
           them in CSS. -->
      <g class="glint classic" style="transform-origin:0 0">
        <circle r="9" fill="var(--ink)" opacity=".12"/>
        <path d="M 0 -12 L 1.7 -1.7 L 12 0 L 1.7 1.7 L 0 12 L -1.7 1.7 L -12 0 L -1.7 -1.7 Z"
              fill="var(--ink)" opacity=".9"/>
        <circle r="2" fill="var(--ink)"/>
      </g>
      <g class="glint tron" style="transform-origin:0 0">
        <circle r="9.5" fill="var(--upcoming)" opacity=".06"/>
        <path d="M 0 -11 L 7.6 0 L 0 11 L -7.6 0 Z" fill="none"
              stroke="url(#tron-edge)" stroke-width="1.5" stroke-linejoin="miter"/>
        <path d="M 0 -4.6 L 3.2 0 L 0 4.6 L -3.2 0 Z" fill="none"
              stroke="var(--accent)" stroke-width="1" opacity=".9"/>
        <g stroke="url(#tron-edge)" stroke-width="1.3" stroke-linecap="round" opacity=".75">
          <line x1="-13.4" y1="0" x2="-10" y2="0"/>
          <line x1="10" y1="0" x2="13.4" y2="0"/>
        </g>
      </g>
      <!-- CLOUDS' OWN MARK — THE SOUNDING BALLOON (§15: every theme earns its
           own symbols; only star-chart and after dark share theirs).

           WHY IT CANNOT BE A STAR. This pack's sky is DAYLIGHT above a cloud
           deck. There is no north star up there to steer by, and drawing one
           anyway is the exact failure §12 forbids — a mark on the screen that
           is not true of what the screen is showing. So the question the mark
           has to answer is the honest one: at altitude, in daylight, what do
           you send UP to put something new into the sky? A sounding. A pilot
           balloon carrying an instrument, released to add one real reading to
           the record — which is what this handle does when it opens the create
           drawer, said in the vocabulary the pack already speaks.

           WHAT IT KEEPS FROM THE GLINT, and why. Retrograde's beacon held the
           old mark's silhouette on purpose ("still reads as a beacon at a
           glance"), and the reasoning travels: this is the same 30px box, the
           same vertical axis, and the two reticle ticks sit at exactly the same
           ±13.4 the glint's horizontal arms did, so the mark's footprint in the
           chrome is unchanged and the eye finds it in the same place. What
           moves is only what it is made of.

           WHAT IT IS MADE OF, and why that is not decoration. Light packs do
           not glow — that law is older than this pack (#426: weight instead of
           luminosity, flat ink instead of gloss) — so the balloon is drawn,
           not lit: the envelope a thin engraved outline with a single pale
           highlight where the low sun catches its shoulder, the rigging two
           hairlines, and the instrument a small SOLID box in the accent at the
           bottom of the axis. The solid box is the one loud element and it is
           load-bearing twice over: it is the only filled shape, so it is what
           the eye lands on, and it sits at the low end of the axis, pointing
           at the drawer the handle pulls — the same job the tron diamond's
           downward vertex does in retrograde. Nothing here is added for
           prettiness; take any one part away and the mark stops reading as an
           instrument going up. -->
      <g class="glint sonde" style="transform-origin:0 0">
        <!-- the envelope: a real pilot balloon is a slightly pear-shaped
             sphere, wider than it is tall at the shoulder and drawn in by the
             neck, which is what stops this reading as a lollipop -->
        <path d="M 0 -12.6 C 5.2 -12.6 7.4 -8.6 7.4 -5.4
                 C 7.4 -2.1 4.4 .1 1.5 1.6 L -1.5 1.6
                 C -4.4 .1 -7.4 -2.1 -7.4 -5.4
                 C -7.4 -8.6 -5.2 -12.6 0 -12.6 Z"
              fill="none" stroke="var(--ink)" stroke-width="1.3"
              stroke-linejoin="round" opacity=".9"/>
        <!-- the shoulder the low sun catches. One stroke, on the sunward side
             only, because there is one light source in this sky and it is the
             reason the pack exists -->
        <path d="M -4.6 -9.4 C -3.2 -11.2 -1.6 -11.8 -.2 -11.9"
              fill="none" stroke="var(--sun)" stroke-width="1.1"
              stroke-linecap="round" opacity=".85"/>
        <!-- the rigging: two hairlines from the neck to the instrument -->
        <g stroke="var(--ink)" stroke-width=".9" opacity=".78">
          <line x1="-1.5" y1="1.9" x2="-1.1" y2="7.2"/>
          <line x1="1.5" y1="1.9" x2="1.1" y2="7.2"/>
        </g>
        <!-- the instrument: the one solid shape, in the create colour, at the
             low end of the axis, pointing at the drawer -->
        <rect x="-3.1" y="7.2" width="6.2" height="5" rx="1.1"
              fill="var(--accent-text)"/>
        <!-- and the reticle ticks, at the glint's own ±13.4 -->
        <g stroke="var(--ink)" stroke-width="1.2" stroke-linecap="round" opacity=".78">
          <line x1="-13.4" y1="0" x2="-10" y2="0"/>
          <line x1="10" y1="0" x2="13.4" y2="0"/>
        </g>
      </g>
    </svg>
    <span>create</span>
  </button>
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
    <!-- backdrop constellations are generated from the galaxy map -->
    <div class="dialwrap">
      <svg width="640" height="640" class="dial" viewBox="0 0 380 380" role="group"
         aria-label="Gravity well: items orbit by due date; distance from the household is time remaining, body size is typical cost; details in the manifest below">
      <defs aria-hidden="true">
        <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4"/>
        </filter>
        <filter id="sun" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="9"/>
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
        <circle cx="190" cy="190" r="13" style="fill:var(--sun)" filter="url(#sun)" opacity=".8"/>
        <circle cx="190" cy="190" r="7" style="fill:var(--sun-core)"/>
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
            {#if b.paint === "ruby" || b.paint === "amber"}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size}
                      style="stroke:var(--bg);stroke-width:2" fill="url(#p-{b.paint})"/>
            {:else if b.paint === "sky"}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size}
                      style="stroke:var(--upcoming);stroke-opacity:.25;stroke-width:2.6" fill="url(#p-sky)"/>
            {:else if b.documentCount > 0}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size}
                      style="stroke:var(--ok);stroke-opacity:.25;stroke-width:3" fill="url(#p-jade)"/>
            {:else}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size} fill="url(#p-jade)"/>
            {/if}
            {#if b.kind === "inspection"}<path d={crescent(b)} fill="rgba(0,0,0,.42)"/>{/if}
            {#if b.kind === "renewal"}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size * 0.57} style="fill:var(--bg)"/>
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size * 0.28} fill="url(#p-{b.paint})"/>
            {/if}
            {#if b.size >= 4}
              <circle cx={b.placement.x - 0.2 * b.size} cy={b.placement.y + 0.25 * b.size}
                      r={0.33 * b.size} fill="rgba(255,255,255,.38)"/>
            {/if}
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
    </div>
    <div class="hero-foot">
      <div class="splash-search" style="position:relative">
        <input id="explore" placeholder="explore your world" aria-label="Search items and documents">
        <div class="palette" data-polish="POL-9" id="palette">
          {#each (groups?.attention ?? []).filter((r) => r.days >= 0).slice(0, 2) as row (row.id)}
            <div><b>{row.title}</b> <small>· {tlabel(row)}</small></div>
          {/each}
          {#if groups?.closest}<div class="act">→ complete "{groups.closest.title}"</div>{/if}
          <div class="act">→ add an item</div>
        </div>
      </div>
    </div>
    {/if}
  </div>

    <!-- §14 (#469): ONE schedule surface. The manifest IS the corridor — a
         full scrollback through events, nearest at the top down to the
         furthest away, suggestions riding the same line in date order. -->
    <div class="manifest" id="manifest-top">
    {#if corridor && !view?.emptySky}
      {#snippet corridorRow(row)}
        {#if row.suggestion}
          {@const s = view.suggestions.find((one) => one.id === row.id)}
          <div class="item suggest" id={row.id}>
            <span class="planet sug" aria-hidden="true"><i></i></span>
            <div class="body"><b>{row.title}</b><span>{[
              `Found in ${row.sourceDocument}`,
              row.dueDate ? `renews ${short(row.dueDate)}` : null,
              row.costMinor ? money(row.costMinor, row.currency, true) : null,
            ].filter(Boolean).join(" · ")}</span></div>
            <!-- #434: approval is the boundary between untrusted mail and
                 the household, so it takes two deliberate taps — the first
                 arms, the second fires. One operation id per receipt makes
                 the write idempotent under any retry. -->
            <div class="actions">
              <button class="yes" disabled={busyReceipt === row.id}
                onclick={() => tapReceipt(s, "approve")}>
                {armed.id === row.id && armed.act === "approve" ? "tap again to approve" : "Add to orbit"}
              </button>
              <button disabled={busyReceipt === row.id}
                onclick={() => tapReceipt(s, "dismiss")}>
                {armed.id === row.id && armed.act === "dismiss" ? "tap again to dismiss" : "Dismiss"}
              </button>
            </div>
            {#if mailProblem && armed.id === row.id}
              <div class="mail-problem">{mailProblem}</div>
            {/if}
          </div>
        {:else}
          <!-- #424: the row is the item. The href is the row's real address —
               kept so a modified click can still open it in its own tab — and
               a plain click expands the row here instead of leaving home. -->
          <a class="item" class:open={expanded === row.id} id={row.id}
             href={resolve(`/home?item=${encodeURIComponent(row.id)}`)} aria-expanded={expanded === row.id}
             aria-controls="{row.id}-view" onclick={(event) => onRowClick(event, row.id)}>
            <span class="planet" class:ter={row.kind === "inspection"} class:con={row.kind === "renewal"}
                  style="color:var({BAND_VAR[row.band]})" aria-hidden="true"><i></i></span>
            <div class="body"><b>{row.title}</b><span>{[
              row.section,
              row.recurrenceMonths ? `orbital period ${period(row.recurrenceMonths)}` : null,
              row.provider,
              row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null,
            ].filter(Boolean).join(" · ")}</span></div>
            {#if row.dueDate}
              <div class="t {T_CLASS[row.band]}">{tlabel(row)}<small>{short(row.dueDate)}</small></div>
            {:else}
              <div class="t ok">—</div>
            {/if}
          </a>
          {#if expanded === row.id}{@render itemview(row)}{/if}
        {/if}
      {/snippet}

      <!-- #424: everything Orbit holds about the item, in the row. The field
           set and its order are the item view's, so the two surfaces say the
           same thing in the same words (web/src/routes/item/[id]). -->
      {#snippet itemview(row)}
        <div class="itemview" id="{row.id}-view" role="region" aria-label="{row.title} — full detail">
          {#if detailProblem}
            <div class="ivproblem" role="alert">{detailProblem}</div>
          {:else if !detail}
            <div class="ivnote">{detailBusy ? "reading…" : ""}</div>
          {:else}
            <div class="kv"><span>due</span>
              <b class:over={detail.band === "overdue" || row.band === "overdue"}>{detailDue(detail)}</b></div>
            {#if detail.snoozedUntil}
              <div class="kv"><span>snoozed until</span><b>{longDate(detail.snoozedUntil)}</b></div>
            {/if}
            {#if detail.status !== "active"}
              <div class="kv"><span>status</span><b>{detail.status}</b></div>
            {/if}
            {#if detail.section}
              <div class="kv"><span>section</span><b>{detail.section}</b></div>
            {/if}
            {#if detail.subtype}
              <div class="kv"><span>type</span><b>{detail.subtype}</b></div>
            {/if}
            {#if detail.recurrenceMonths}
              <div class="kv"><span>orbital period</span><b>{every(detail.recurrenceMonths)}</b></div>
            {/if}
            <div class="kv"><span>cost</span>
              <b>{money(detail.costMinor, detail.currency, detail.costIsEstimate)}</b></div>
            {#if detail.provider}
              <div class="kv"><span>provider</span><b>{detail.provider}</b></div>
            {/if}
            {#if detail.reference}
              <div class="kv"><span>reference</span><b>{detail.reference}</b></div>
            {/if}
            {#if detail.reminderDays?.length}
              <div class="kv"><span>reminders</span>
                <b>{detail.reminderDays.map((d) => `${d}d before`).join(" · ")}</b></div>
            {/if}
            {#if detail.documents?.length}
              <h4>documents</h4>
              {#each detail.documents as document (document.name)}
                <div class="doc">◆<span>{document.name}<small>{document.meta}</small></span></div>
              {/each}
            {/if}
            {#if detail.notes}
              <h4>notes</h4>
              <p>{detail.notes}</p>
            {/if}
            <div class="ivfoot">
              <button class="ivcopy" onclick={copyAddress}>{copied ? "link copied" : "copy link"}</button>
              <a class="ivfull" href={resolve("/item/[id]", { id: row.id })}>manage this item →</a>
            </div>
          {/if}
        </div>
      {/snippet}
      <div class="corridor">
        {#if corridor.overdue.length}
          <div class="redzone">
            {#each corridor.overdue as row (row.id)}{@render corridorRow(row)}{/each}
          </div>
        {/if}
        <div class="today"><span class="sunmark" aria-hidden="true"><i></i><b></b></span><span>TODAY · {todayLine}</span><div class="rule"></div></div>
        {#each corridor.current as row (row.id)}{@render corridorRow(row)}{/each}
        {#each corridor.months as month (month.key)}
          <div class="month"><span>{month.label}</span><div class="rule"></div><small>{month.rows.length} approaching</small></div>
          {#each month.rows as row (row.id)}{@render corridorRow(row)}{/each}
        {/each}
        {#each corridor.undated as row (row.id)}{@render corridorRow(row)}{/each}
      </div>
      {#if corridor.total === 0}
        <div class="horizon">— nothing scheduled: your sky is quiet —</div>
      {:else if corridor.horizon}
        <div class="horizon">— beyond the horizon: nothing scheduled past {corridor.horizon} —</div>
      {/if}
    {/if}
  </div>
</div>

<aside class="drawer drawer-left" id="statusdrawer" role="region" aria-label="System status">
  <button class="handle" id="edge-health" aria-expanded="false">
    <i></i><span>degraded</span></button>
  <h4>System status</h4>
  <div class="svc"><i style="background:var(--ok)"></i><b>orbit-app</b><small>healthy &middot; 40s ago</small></div>
  <div class="svc"><i style="background:var(--ok)"></i><b>orbit-postgres</b><small>healthy &middot; 40s ago</small></div>
  <div class="svc"><i style="background:var(--degraded)"></i><b>orbit-clamav</b><small>unreachable &middot; 2m ago</small></div>
  <div class="svc"><i style="background:var(--ink-faint)"></i><b>orbit-tika</b><small>not enabled</small></div>
  <div class="svc"><i style="background:var(--ok)"></i><b>scheduler</b><small>running &middot; 12s ago</small></div>
  <h4>Last health check</h4>
  <div class="svc"><i style="background:var(--degraded)"></i><b>scan readiness</b><small>failed &middot; scanner-unreachable</small></div>
  <div class="svc"><i style="background:var(--ok)"></i><b>application</b><small>ready</small></div>
  <h4>Full diagnostics</h4>
  <div class="svc" style="color:var(--ink-faint)">container logs &middot; or the launcher repair flow</div>
</aside>
{#if !view?.emptySky}
<aside class="drawer drawer-right" id="keydrawer" role="region" aria-label="Chart key">
  <button class="handle" aria-expanded="false">
    <i></i><span>key</span></button>
  <h4>Urgency</h4>
  <div class="keyrow"><span class="sw" style="background:var(--overdue)"></span>overdue &mdash; inside the ring</div>
  <div class="keyrow"><span class="sw" style="background:var(--warm)"></span>due soon</div>
  <div class="keyrow"><span class="sw" style="background:var(--upcoming)"></span>upcoming</div>
  <div class="keyrow"><span class="sw" style="background:var(--ok)"></span>on track &mdash; wide orbit</div>
  <h4>Types</h4>
  <div class="keyrow"><span class="sw" style="background:var(--ink-mid)"></span>routine service</div>
  <div class="keyrow"><span class="sw" style="background:radial-gradient(circle,var(--ink-mid) 24%,var(--panel-raised) 34%,var(--ink-mid) 52%)"></span>renewal / contract</div>
  <div class="keyrow"><span class="sw" style="background:linear-gradient(90deg,var(--ink-mid) 50%,rgba(0,0,0,.55) 50%)"></span>inspection / certification</div>
  <div class="keyrow"><span class="sw" style="background:none;border:1.6px solid var(--accent)"></span>suggestion &mdash; not yet accepted</div>
  <h4>Physics</h4>
  <div class="keyrow">closer = sooner</div>
  <div class="keyrow">bigger = costlier</div>
  <div class="keyrow">belt = documents attached</div>
  <div class="keyrow">the sky&rsquo;s weather = your workload</div>
</aside>
<div class="docview" id="docview" role="dialog" aria-label="Documents">
  <button class="close">×</button>
  <h4 id="docview-title">Car full service</h4>
  <div class="sub">2 documents · encrypted · scanned clean</div>
  <div class="doc">◆<span>service-invoice-2026.pdf<small>added 12 Jun · 240 KB</small></span></div>
  <div class="doc">◆<span>service-checklist.pdf<small>added 12 Jun · 88 KB</small></span></div>
</div>
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
