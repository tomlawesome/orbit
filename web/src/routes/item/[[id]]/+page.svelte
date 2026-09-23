<script>
  import { onMount, tick } from "svelte";
  import { goto, invalidateAll, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { mountTiledSky } from "$lib/sky.js";
  import { every, longDate, money } from "$lib/format.js";
  import Chrome from "$lib/Chrome.svelte";
  import { WorkspaceError, applyCommand, restoreDocument } from "$lib/data/workspace.js";
  import { beltManifestOf, documentPreviewStateOf } from "$lib/data/belt.js";
  import {
    archiveCommand, completeCommand, nextDateAfter, rescheduleCommand,
    snoozeCommand, statusCommand, upsertCommand,
  } from "$lib/data/commands.js";
  import {
    COST_LOCKED, DAMAGED, DAMAGED_PLACEHOLDER, LOCKED, NOTES_WORDS, PANEL_LOCKED, REFERENCE_WORDS,
    fieldState, itemLocked, saveProblem,
  } from "$lib/data/metadata-status.js";
  import { matchesOf, nearestMatchOf, reachableAt, stepFrom } from "./band.js";
  import { mountBelt } from "./belt.behaviour.js";
  import "./belt.css";

  /**
   * THE ITEM BELT (#458) — and, by the owner's ruling of 2026-08-16, the item
   * screen itself: "this surface IS the item screen. Arriving at an item from
   * anywhere else — a manifest row on home, a filed lane in the inbox, a link
   * in a reminder — lands you HERE with that item already seated at the apex
   * and its neighbours in time already around it."
   *
   * Built from design/v19/item-belt.html, which is sealed and is the law for
   * every pixel of it. Every item in the household rides one tilted ring in
   * strict order of when it comes due — sooner left, later right — jumbled
   * through the band's thickness but never out of order; the centred body is
   * its own card, seated at the apex; and the centred item's documents ride in
   * the belt beside it, ringed, glowing and slowly breathing.
   *
   * What lives where: the arithmetic is band.js (pure, unit-tested), the
   * canvas and the roll are belt.behaviour.js, the manifest transform is
   * $lib/data/belt.js and the reads are the seam's readBelt(). This file is
   * the markup, the card, the search and the commands.
   *
   * The commands are #455's, unchanged: the same builders, the same
   * optimistic-concurrency contract, the same words. The retired item view's
   * rendering is gone — the belt is what /item/<id> draws now — but its
   * writes were never the thing being replaced.
   */

  /**
   * The belt's vocabulary, taken from the two modules that own it (#624).
   *
   * @typedef {import("./band.js").Body}       Body
   * @typedef {import("./band.js").BeltRow}    BeltRow
   * @typedef {import("./band.js").ItemRecord} ItemRecord
   * @typedef {import("./belt.behaviour.js").BeltController} BeltController
   */

  /** @typedef {"complete" | "reschedule" | "snooze" | "edit" | "retire"} PanelName */

  /**
   * The command panels' fields, as the inputs bind them: strings, one panel's
   * worth at a time. Each panel fills what it needs and leaves the rest
   * unset, which is why every field is optional rather than blank.
   *
   * @typedef  {object} PanelForm
   * @property {string} [completedDate]
   * @property {string} [nextDate]
   * @property {string} [cost]
   * @property {string} [notes]
   * @property {string} [dueDate]
   * @property {string} [until]
   * @property {string} [title]
   * @property {string} [provider]
   * @property {string} [reference]
   * @property {string | number} [recurrenceMonths]
   */

  let { data } = $props();

  /* #434: an id that is a mail-in receipt is not an item and has no seat in
     the band. It forks to its own component, imported lazily so the belt
     does not run its code — see Suggestion.svelte. Its item.css still lands
     in this route's CSS bundle, so every rule in it is scoped to the card. */
  const suggestionView =
    data.kind === "suggestion" ? import("./Suggestion.svelte").then((m) => m.default) : null;
  /* readBelt only ever sets `item` alongside kind: "suggestion" (workspace.js);
     the union isn't discriminated at the type level because its `kind` values
     come back as plain `string`, so this only asserts what data.kind === "suggestion"
     already guarantees at runtime. */
  const suggestionItem = /** @type {import('$lib/data/workspace.js').ItemView} */ (data.item);

  /** @type {HTMLDivElement | null} */
  let root = $state(null);
  /** @type {HTMLDivElement | null} */
  let sky = $state(null);
  /** @type {BeltController | null} */
  let belt = null;

  /* What the screen shows. `bodies` and `bloom` are copies taken from the
     controller at each settle: the band owns them, the markup only reads. */
  /** @type {Body[]} */
  let bodies = $state.raw([]);
  /** @type {number[]} */
  let bloom = $state.raw([]);
  let selected = $state(0);
  /* The type rides on the initial value, not on a declaration comment: the
     band writes this from its own callbacks, so a plain `null` would have
     the derivations below reading a variable narrowed to null for ever. */
  let cardBody = $state(/** @type {Body | null} */ (null));
  let query = $state("");
  /** @type {Set<number>} */
  let matches = $state.raw(new Set());

  /* The command surface, the item view's own (#455). */
  /** @type {PanelName | null} */
  let panel = $state(null);
  /** @type {"archive" | "cancel" | null} */
  let armed = $state(null);
  let busy = $state(false);
  /** @type {string | null} */
  let problem = $state(null);
  /** @type {PanelForm} */
  let form = $state({});

  /* ---- the document preview (#1088) --------------------------------------
     create-v3's reading card (design/v19/create-v3.html's `.readcard`,
     `.topsheet`, `.focus`), reused for its two everyday states — focus while
     the page is on its way, snap once it has landed — plus the four honest
     ones owner-decisions.md §18 draws when there is none to show. A document
     is never the centred body: this rides entirely beside `selected`, opened
     and closed by the belt's own openDoc/closeDoc (a paper's own press)
     rather than by centring anything. The belt owns WHICH paper and WHICH
     side; this screen owns what the card says about it, same division as
     the item card and its panels. */
  /** @type {import("./band.js").BeltDoc | null} */
  let previewDoc = $state(null);
  let previewSide = $state(/** @type {"left" | "right"} */ ("right"));
  /** Drives the reading card's own fade — true one tick after it is asked to
     open, and false the instant it is asked to close, so both ends of the
     opacity/transform transition actually run rather than snapping. */
  let previewOpen = $state(false);
  let previewImgLoaded = $state(false);
  let previewImgFailed = $state(false);
  /* create-v3's own walk: the page does not appear the instant it has
     loaded — it waits for a minimum beat so a fast load never flickers. */
  let previewBeatDone = $state(false);
  let previewRestoring = $state(false);
  /** @type {string | null} */
  let previewProblem = $state(null);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let previewCloseTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let previewBeatTimer;

  const previewDocState = $derived(previewDoc ? documentPreviewStateOf(previewDoc) : null);
  /* A document Orbit believed showable but whose actual page failed to load
     (the preview endpoint refused it for a reason the summary could not
     predict, e.g. a structurally invalid PDF) reads exactly as "a kind
     Orbit cannot draw" — the same honest line, never a stuck loading state. */
  const previewState = $derived(previewImgFailed ? "undrawable" : previewDocState);
  const previewShowing = $derived(
    previewDocState === "available" && previewImgLoaded && previewBeatDone && !previewImgFailed,
  );
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** @param {import("./band.js").BeltDoc} doc
      @param {"left" | "right"} side */
  function openPreview(doc, side) {
    clearTimeout(previewCloseTimer);
    clearTimeout(previewBeatTimer);
    previewDoc = doc;
    previewSide = side;
    previewImgLoaded = false;
    previewImgFailed = false;
    previewRestoring = false;
    previewProblem = null;
    previewBeatDone = documentPreviewStateOf(doc) !== "available";
    if (!previewBeatDone) {
      previewBeatTimer = setTimeout(() => { previewBeatDone = true; }, reducedMotion() ? 0 : 900);
    }
    if (!previewOpen) tick().then(() => { previewOpen = true; });
  }
  function closePreview() {
    if (!previewDoc) return;
    previewOpen = false;
    clearTimeout(previewBeatTimer);
    /* The card stays mounted through its own fade-out, same choreography as
       the belt's cardwrap swap and create-v3's own topsheet. */
    previewCloseTimer = setTimeout(() => { previewDoc = null; }, reducedMotion() ? 0 : 800);
  }
  /* The reading card sits level with the item card's own middle (create-v3's
     levelWithCard, belt.behaviour.js's port of it) — a figure only the belt
     can answer, because it is measured off the item card's real footprint.
     Every visual change to the reading card's own height (opening, the page
     landing, an honest state replacing the loading block) has to ask again. */
  $effect(() => {
    void previewDoc; void previewShowing; void previewState;
    if (previewDoc) tick().then(() => belt?.remeasure());
  });
  /** The removed state's one foot action (#1054's restore, reached here
     rather than through the reader this issue does not build). */
  async function restorePreviewDoc() {
    if (!previewDoc || previewRestoring) return;
    previewRestoring = true;
    previewProblem = null;
    try {
      await restoreDocument(previewDoc.id);
      belt?.closeDoc();
      await invalidateAll();
    } catch (error) {
      previewProblem = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
    } finally {
      previewRestoring = false;
    }
  }

  /** @type {HTMLInputElement | null} */
  let findEl = $state(null);
  /* Deliberately NOT reactive, all three: the mounting effect reads them and
     the band's callbacks write them, so making them state would make the
     effect depend on its own output and rebuild the belt for ever. */
  /** @type {string | null} */
  let centredId = null;
  /** @type {string | null} */
  let cardId = null;
  /** @type {string | null} */
  let addressId = data.selectedId ?? null;
  let routerReady = false;

  const row = $derived(cardBody?.item ?? null);              /* the manifest row  */

  /* #941: why a Tier 1 field is absent, when it is. Damaged means the stored
     value is gone and retyping replaces it; locked means it is intact and
     waiting for an administrator. `locked` is read at PANEL level, not field
     level, because item.upsert is a full-row write: while the key is away
     every edit to this item is refused, not just the two encrypted fields.
     The complete panel is the one exception (#972): item.complete only
     reaches for the key when a cost is given, so there `locked` gates the
     cost input alone and the rest of the panel — including the save button
     for a no-cost completion — stays live. */
  const referenceState = $derived(fieldState(row?.metadataStatus, "reference"));
  const notesState = $derived(fieldState(row?.metadataStatus, "notes"));
  const locked = $derived(itemLocked(row?.metadataStatus));
  const record = $derived(cardBody?.kind === "item" ? cardBody.item.item : null); /* the raw item */
  /** @type {(days: number[]) => string} */
  const remindOf = (days) => days.map((d) => `${d}d`).join(" and ") + " before";

  /* ---- mounting the band ------------------------------------------------
     The belt is rebuilt whenever the data changes, which is what a command's
     re-read is: completing an item moves it in time, so the band it rides in
     has to be laid out again — with the same body still centred. */
  $effect(() => {
    if (data.kind !== "belt" || !root) return;
    const rows = beltManifestOf({
      household: data.household,
      documentsByItem: data.documentsByItem,
      /* Same cast as suggestionItem above and for the same reason: data.kind
         comes back as plain `string`, so the data.kind === "belt" guard this
         effect already made does not narrow `today` into existence at the
         type level even though it always does at runtime. */
      today: /** @type {string} */ (data.today),
      keepId: data.selectedId,
    });
    const focus = centredId ?? data.selectedId;
    const controller = mountBelt(root, {
      manifest: rows,
      selectedId: rows.some((/** @type {BeltRow} */ one) => one.id === focus) ? focus : data.selectedId,
      /* The band hands itself to every callback, because the first layout runs
         inside mountBelt — before `controller` below has been assigned. */
      onSelect(i, band) {
        selected = i;
        bodies = band.bodies;
        const body = band.bodies[i];
        if (!body) return;
        centredId = body.id;
        address(body.kind === "doc" ? body.item.id : body.id);
      },
      onSwap(i, band) {
        const body = band.bodies[i];
        /* A different body at the apex is a different subject: its panels,
           its arming and its failure line all belong to what left. A re-read
           that lands on the SAME body keeps them, which is what makes a
           refused command's message survive the invalidation it triggers. */
        if ((body?.id ?? null) !== cardId) { panel = null; armed = null; problem = null; }
        cardId = body?.id ?? null;
        cardBody = body;
      },
      /* #1062: the end-caps' press. The same function the arrow keys call —
         the band draws the controls, the screen owns the step. */
      onStep: step,
      /* #1088: a paper was pressed. The apex does not move — see openPreview. */
      onOpenPreview(doc, side) { openPreview(doc, side); },
      onClosePreview() { closePreview(); },
      async onSettle(_i, band) {
        bloom = band.bloom.slice();
        bodies = band.bodies;
        /* The card is Svelte's, so it exists one tick after it is asked for:
           the band measures its footprint once it is really there, then lays
           the rubble down around it. */
        await tick();
        band.remeasure?.();
      },
    });
    belt = controller;
    return () => { controller.destroy(); if (belt === controller) belt = null; };
  });

  onMount(() => {
    if (sky) mountTiledSky(sky, "belt");
    /* Shallow routing is only legal once the router is up. */
    routerReady = true;
  });

  /** The address follows the apex: centring another item makes the one in the
     browser's bar a lie. REPLACE, never push — ← and → are reading, not
     navigating, and Back must still leave the way you came in (#424's rule
     for the expanded row, in the belt's grammar). A document has no address
     of its own yet, so it keeps its item's.
     @param {string} itemId */
  function address(itemId) {
    if (!routerReady || !itemId || itemId === addressId) return;
    addressId = itemId;
    try {
      replaceState(resolve("/item/[[id]]", { id: encodeURIComponent(itemId) }), {});
    } catch {
      /* No router (a direct render, a test harness): the belt still works. */
    }
  }

  /* ---- the search box ---------------------------------------------------
     Typing LIGHTS the matches and DIMS the rest; nothing vanishes, because
     the belt keeps its shape and you are meant to see where in time your hit
     sits. Enter centres the nearest match along the belt. */
  /** @param {Event & { currentTarget: EventTarget & HTMLInputElement }} event */
  function onFind(event) {
    query = event.currentTarget.value;
    matches = matchesOf(bodies, query);
    belt?.setQuery(query, matches);
  }
  const hitList = $derived(
    query.trim() ? [...matches].filter((i) => reachableAt(bodies, i, bloom)) : [],
  );
  const nearest = $derived(
    query.trim() && bodies.length ? nearestMatchOf(bodies, matches, selected, bloom) : -1,
  );
  const itemCount = $derived(bodies.filter((b) => b.kind === "item").length);
  const findnote = $derived(
    !bodies.length
      ? "the belt is empty"
      : !query.trim()
        /* #1062: the note says what ORDER the belt is in, not which keys move
           it. The end-caps are the visible way along it now, and the arrow
           keys keep working as the shortcut they always were. */
        ? `${itemCount} items · in date order, sooner to later`
        : hitList.length
          ? `${hitList.length} of ${itemCount} lit · enter centres the nearest`
          : "nothing matches · the belt keeps its shape",
  );

  /** @param {KeyboardEvent} event */
  function onFindKey(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (nearest >= 0) goTo(nearest);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (findEl?.value) {
        findEl.value = "";
        query = "";
        matches = new Set();
        belt?.setQuery("", matches);
      } else findEl?.blur();
    }
  }

  /* ---- keyboard ---------------------------------------------------------
     ← and → step through the belt in date order, which is its whole grammar
     — over the papers too, when they are out. Inside the search field the
     arrows belong to the caret; inside a command panel they belong to the
     field being typed into, which the mockup never had to think about
     because its pills were inert. */
  /** @param {EventTarget | null} target */
  function typing(target) {
    return target instanceof Element
      && (target === findEl || Boolean(target.closest("input, textarea, select")));
  }
  /**
   * Go to a seat, whichever kind it is: a rock rolls to the apex; a paper
   * opens its reading card in place (#1088 — a document is never the
   * centred body). Every way this screen can be told "go to seat i" — the
   * end-caps, the arrow keys, Enter in the search field, a hit list row —
   * goes through this one function rather than three that have to agree.
   *
   * @param {number} i
   */
  function goTo(i) {
    const body = bodies[i];
    if (!body) return;
    if (body.kind === "doc") belt?.openDoc(i);
    else belt?.centre(i);
  }

  /**
   * One step along the belt. The whole of what ← and → do — and, since
   * #1062, the whole of what the two end-caps do as well: they are handed
   * this function, so a press and a key press are one code path and land the
   * same way rather than two that have to be kept agreeing.
   *
   * @param {number} d  -1 for sooner, +1 for later
   */
  function step(d) {
    const next = stepFrom(bodies, selected, bloom, d);
    if (next >= 0) goTo(next);
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    /* #1088: Esc closes the reading card first — the belt's own dead-space
       law (owner-decisions.md §18) — and only then a command panel. */
    if (event.key === "Escape" && previewDoc) { event.preventDefault(); belt?.closeDoc(); return; }
    if (event.key === "Escape" && panel) { panel = null; armed = null; return; }
    if (typing(event.target)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
    if (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key === "k")) {
      event.preventDefault();
      findEl?.focus();
      findEl?.select();
    }
  }

  /* ---- the commands (#455) ---------------------------------------------- */
  const todayISO = () => data.today ?? new Date().toISOString().slice(0, 10);
  /** @type {(minor?: number | null) => string} */
  const pounds = (minor) => (minor === null || minor === undefined ? "" : (minor / 100).toFixed(2));
  /** @type {(text?: string) => number | undefined} */
  const minorOf = (text) => {
    const value = Number.parseFloat(String(text).replace(",", "."));
    return Number.isFinite(value) ? Math.round(value * 100) : undefined;
  };

  /**
   * A panel is always about the record at the apex, so it is handed the one
   * it is opening on rather than reaching for it: only the item card renders
   * these buttons, which is where the record is known to be there.
   *
   * @param {PanelName}  name
   * @param {ItemRecord} item
   */
  function open(name, item) {
    problem = null;
    armed = null;
    panel = panel === name ? null : name;
    if (panel === "complete") {
      const done = todayISO();
      form = {
        completedDate: done,
        nextDate: nextDateAfter(done, item.recurrenceMonths) ?? "",
        cost: pounds(item.costMinor),
        notes: "",
      };
    }
    if (panel === "reschedule") form = { dueDate: item.dueDate ?? todayISO() };
    if (panel === "snooze") form = { until: item.snoozedUntil ?? todayISO() };
    if (panel === "edit") {
      form = {
        title: item.title,
        provider: item.provider ?? "",
        reference: item.reference ?? "",
        cost: pounds(item.costMinor),
        dueDate: item.dueDate ?? "",
        recurrenceMonths: item.recurrenceMonths ?? "",
        notes: item.notes ?? "",
      };
    }
  }

  /** One writer. Success re-reads the belt — the item may have moved in time,
     so the band it rides in is laid out again around it. Completing something
     that does not come round again leaves for the orbit, because this address
     no longer has a body to centre. A 409 surfaces in the server's own words
     and the re-read shows the truth that beat us; nothing is silently
     overwritten.
   *
   * @param {() => object} build  the command to send
   * @param {{ leave?: boolean }} [options] */
  async function run(build, { leave = false } = {}) {
    busy = true;
    problem = null;
    try {
      await applyCommand(build());
      panel = null;
      armed = null;
      if (leave) await goto(resolve("/home"));
      else await invalidateAll();
    } catch (error) {
      /* The seam throws WorkspaceError and nothing else carries a `code`,
         so this is the same two readings the line always made. */
      /* #941: the one refusal that gets the member's own words rather than
         the server's is the locked 503 -- a panel opened before the key went
         away and sent after it. Everything else keeps what the server said. */
      problem = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      if (error instanceof WorkspaceError && error.code === "version_conflict") await invalidateAll();
    } finally {
      busy = false;
    }
  }

  /** Two taps for what cannot be undone, the protocol home and the inbox use
     for exactly the same reason (#434): the first tap arms, the second acts.
   *
   * @param {"archive" | "cancel"} act
   * @param {() => unknown} go */
  function tap(act, go) {
    if (armed !== act) { armed = act; return; }
    go();
  }

  /** #1088: dead space closes the reading card (owner-decisions.md §18) —
     everything on the belt except the paper itself, the item card, the
     reading card, the search field and the chrome. */
  /** @param {PointerEvent} event */
  function onDeadSpace(event) {
    if (!previewDoc) return;
    const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
    if (target?.closest?.(".readcard, .cardwrap, .hit, .find, .back, .orb, .account")) return;
    belt?.closeDoc();
  }

  const editsOf = () => ({
    title: (form.title ?? "").trim(),
    provider: (form.provider ?? "").trim() || undefined,
    reference: (form.reference ?? "").trim() || undefined,
    costMinor: minorOf(form.cost),
    dueDate: form.dueDate || undefined,
    recurrenceMonths: form.recurrenceMonths ? Number(form.recurrenceMonths) : undefined,
    notes: (form.notes ?? "").trim() || undefined,
  });
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onDeadSpace} />

<svelte:head>
  <title>{data.kind === "belt" ? (row?.title ?? "Item") : "Suggestion"} — Orbit</title>
</svelte:head>

{#if data.kind === "suggestion"}
  {#await suggestionView then Suggestion}
    <Suggestion item={suggestionItem} />
  {/await}
{:else}
<!-- The shared chrome (#1010): the way back to the sky and the account menu.
     A sibling of the belt, not a child, so belt.css's own `.belt-page .back`
     (the in-card links) never reaches the chrome's link of the same name. -->
<Chrome user={data.kind === "belt" ? data.user : null} current="item"
        role={data.kind === "belt" && data.household
          ? `${data.household.name ?? ""} · ${data.household.canManage ? "owner" : "member"}` : ""} />

<div class="belt-page" bind:this={root} role="main">
  <!-- #843: sr-only -- the visible title is the centred card's own h2. -->
  <h1 class="sr-only">Item</h1>
  <div class="sky" aria-hidden="true" bind:this={sky}></div>
  <div class="vignette" aria-hidden="true"></div>

  <!-- the band: everything at or behind the ring plane -->
  <canvas id="band" aria-hidden="true"></canvas>

  <!-- the members: every item in the household in date order along the band,
       plus the centred item's documents in the berth beside it -->
  <svg id="members" aria-label="The item belt: every item in this household, placed in order of when it comes due — sooner to the left, later to the right. The body at the apex of the band is shown as its card, and its documents ride in the belt beside it.">
    <defs>
      <!-- The rock's shading, lit from the same quarter as home's planets, so
           every body in the sky shares one light. -->
      <radialGradient id="rockshade" cx="32%" cy="26%" r="82%">
        <stop offset="0%" stop-color="#000" stop-opacity="0"/>
        <stop offset="55%" stop-color="#000" stop-opacity=".16"/>
        <stop offset="100%" stop-color="#000" stop-opacity=".46"/>
      </radialGradient>
      <!-- the documents' glow: the perimeter line, blurred twice under itself -->
      <filter id="docglow" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur stdDeviation="5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <!-- #1062: the end-caps are controls, so this group is no longer hidden
         from a screen reader — it holds the two buttons that step the belt. -->
    <g id="ends"></g>
    <g id="seats"></g>
    <g id="caps"></g>
  </svg>

  <!-- #1088: create-v3's lanes — the grid the reading card grows beside.
       The card's own column stays put; the second widens on the paper's own
       side when a preview is open, sliding the item card off centre and the
       pair together (owner-decisions.md §18, design/v19/create-v3.html). -->
  <div class="lanes" id="lanes"
       class:left={previewSide === "left"} class:right={previewSide === "right"}
       class:open={previewOpen}>
  <!-- the card, riding at the apex -->
  <div class="cardwrap" id="cardwrap">
    {#if !bodies.length}
      <!-- The empty household. The band is still a belt — ambient rock and
           dust, thinner, because nothing here has swept anything yet. -->
      <article class="glass item-card">
        <h2>Nothing in orbit yet.</h2>
        <a class="back" href={resolve("/inbox")}>open inbox</a>
        <div class="sub">{data.household?.name ?? "your system"} · an empty manifest</div>
        <div class="note">the belt IS the manifest. every item you add takes a seat in it,
          in the order it comes due — sooner to the left, later to the right — and the one
          you are looking at rides at the apex as this card. add the first and the band has
          something to carry.</div>
        <h3>start</h3>
        <div class="acts" role="group" aria-label="Actions">
          <button style="--act:var(--accent);--act-text:var(--accent-text)" onclick={() => goto(resolve("/create"))}>add an item</button>
          <button style="--act:var(--upcoming);--act-text:var(--upcoming-text)" onclick={() => goto(resolve("/inbox"))}>mail something in</button>
        </div>
      </article>
    {:else if cardBody && row && record}
      <!-- An item shows the item screen as #424/#455 render it: what it is,
           when it is due, how often it comes round, what it costs, who does
           it, when you will be warned, every command reachable. It does NOT
           list its documents any more — they are out in the band beside it,
           which is the owner's ruling; the card only says so, and how many. -->
      <article class="glass item-card">
        <h2>{row.title}</h2>
        <div class="sub">{[row.section, row.kind].filter(Boolean).join(" · ")}</div>
        <!-- #1005: a one-off ends on its day; nothing is due on it. -->
        <div class="kv"><span>{row.kind === "expiry" ? "ends" : "due"}</span><b class={row.urg}>{row.t} · {row.longWhen}</b></div>
        {#if row.snoozedUntil}
          <div class="kv"><span>snoozed until</span><b>{longDate(row.snoozedUntil)}</b></div>
        {/if}
        {#if row.status !== "active"}
          <div class="kv"><span>status</span><b>{row.status}</b></div>
        {/if}
        {#if row.kind === "expiry"}
          <div class="kv"><span>orbital period</span><b>one-off — does not come round</b></div>
        {:else if row.months}
          <div class="kv"><span>orbital period</span><b>{every(row.months)}</b></div>
        {/if}
        <div class="kv"><span>cost</span><b>{money(row.cost, row.currency, row.costIsEstimate)}</b></div>
        {#if row.provider}
          <div class="kv"><span>provider</span><b>{row.provider}</b></div>
        {/if}
        <!-- #941: the row renders on the marker as well as on the value. Both
             states used to vanish behind a truthiness test, so a reference
             Orbit could not read looked exactly like one nobody had entered. -->
        {#if row.reference}
          <div class="kv"><span>reference</span><b>{row.reference}</b></div>
        {:else if referenceState === DAMAGED}
          <div class="kv"><span>reference</span>
            <b class="failed"><i aria-hidden="true"></i>{REFERENCE_WORDS[DAMAGED]}</b></div>
        {:else if referenceState === LOCKED}
          <div class="kv"><span>reference</span><b class="locked">{REFERENCE_WORDS[LOCKED]}</b></div>
        {/if}
        {#if row.remind.length}
          <div class="kv"><span>reminders</span><b>{remindOf(row.remind)}</b></div>
        {/if}

        <h3>actions</h3>
        <div class="acts" role="group" aria-label="Item actions">
          {#if row.status === "active"}
            <button style="--act:var(--ok);--act-text:var(--ok-text)" aria-pressed={panel === "complete"}
                    onclick={() => open("complete", record)}>complete</button>
            <button style="--act:var(--upcoming);--act-text:var(--upcoming-text)" aria-pressed={panel === "reschedule"}
                    onclick={() => open("reschedule", record)}>reschedule</button>
            <button style="--act:var(--warm);--act-text:var(--warm-text)" aria-pressed={panel === "snooze"}
                    onclick={() => open("snooze", record)}>snooze</button>
            <button style="--act:var(--accent);--act-text:var(--accent-text)" aria-pressed={panel === "edit"}
                    onclick={() => open("edit", record)}>edit</button>
            <button style="--act:var(--overdue);--act-text:var(--overdue-text)" aria-pressed={panel === "retire"}
                    onclick={() => open("retire", record)}>retire</button>
          {:else}
            <button style="--act:var(--ok);--act-text:var(--ok-text)" disabled={busy}
                    onclick={() => run(() => statusCommand(record, "active"))}>restore</button>
            {#if row.status !== "archived"}
              <button style="--act:var(--overdue);--act-text:var(--overdue-text)" aria-pressed={panel === "retire"}
                      onclick={() => open("retire", record)}>retire</button>
            {/if}
          {/if}
        </div>

        {#if panel === "complete"}
          <div class="panel" style="--act:var(--ok);--act-text:var(--ok-text)">
            <div class="row2">
              <div class="field"><label for="a-done">completed on</label>
                <input id="a-done" type="date" bind:value={form.completedDate}></div>
              {#if record.recurrenceMonths}
                <div class="field"><label for="a-next">next orbit</label>
                  <input id="a-next" type="date" bind:value={form.nextDate}></div>
              {/if}
            </div>
            <div class="row2">
              <div class="field mono"><label for="a-cost">actual cost</label>
                <input id="a-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional"
                       disabled={locked}></div>
            </div>
            <div class="field"><label for="a-cnotes">notes</label>
              <input id="a-cnotes" bind:value={form.notes} placeholder="optional"></div>
            {#if locked}
              <div class="note">{COST_LOCKED}</div>
            {/if}
            <div class="save-row">
              <button class="btn-primary" disabled={busy || !form.completedDate}
                onclick={() => run(() => completeCommand(record, {
                  completedDate: form.completedDate,
                  nextDate: form.nextDate || undefined,
                  costMinor: minorOf(form.cost),
                  notes: (form.notes ?? "").trim() || undefined,
                }), { leave: !form.nextDate })}>complete</button>
              <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "reschedule"}
          <div class="panel" style="--act:var(--upcoming);--act-text:var(--upcoming-text)">
            <div class="field"><label for="a-due">new due date</label>
              <input id="a-due" type="date" bind:value={form.dueDate}></div>
            <div class="save-row">
              <button class="btn-primary" disabled={busy || !form.dueDate}
                onclick={() => run(() => rescheduleCommand(record, form.dueDate))}>reschedule</button>
              <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "snooze"}
          <div class="panel" style="--act:var(--warm);--act-text:var(--warm-text)">
            <div class="field"><label for="a-until">snooze until</label>
              <input id="a-until" type="date" bind:value={form.until}></div>
            <div class="save-row">
              <button class="btn-primary" disabled={busy || !form.until}
                onclick={() => run(() => snoozeCommand(record, form.until))}>snooze</button>
              <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "edit"}
          <!-- #941. Damaged: the input stays enabled and seeded empty, and its
               placeholder says what saving will do -- the panel is where that
               has to be visible, because a full-row upsert writes the field
               whether or not it was touched, so a member saving past the
               placeholder has decided. Locked: every input, not only the two
               encrypted ones, because item.upsert is refused whole. -->
          <div class="panel" style="--act:var(--accent);--act-text:var(--accent-text)">
            <div class="field"><label for="e-title">title</label>
              <input id="e-title" bind:value={form.title} disabled={locked}></div>
            <div class="row2">
              <div class="field"><label for="e-provider">provider</label>
                <input id="e-provider" bind:value={form.provider} placeholder="optional" disabled={locked}></div>
              <div class="field"><label for="e-reference">reference</label>
                <input id="e-reference" bind:value={form.reference} disabled={locked}
                       placeholder={referenceState === DAMAGED ? DAMAGED_PLACEHOLDER : "optional"}></div>
            </div>
            <div class="row2">
              <div class="field mono"><label for="e-cost">cost</label>
                <input id="e-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional" disabled={locked}></div>
              <div class="field"><label for="e-due">due date</label>
                <input id="e-due" type="date" bind:value={form.dueDate} disabled={locked}></div>
            </div>
            <div class="field"><label for="e-recur">orbital period (months)</label>
              <input id="e-recur" inputmode="numeric" bind:value={form.recurrenceMonths} placeholder="optional"
                     disabled={locked}></div>
            <div class="field"><label for="e-notes">notes</label>
              <textarea id="e-notes" rows="3" bind:value={form.notes} disabled={locked}
                        placeholder={notesState === DAMAGED ? DAMAGED_PLACEHOLDER : "optional"}></textarea></div>
            {#if locked}
              <div class="note">{PANEL_LOCKED}</div>
            {/if}
            <div class="save-row">
              <button class="btn-primary" disabled={busy || locked || !form.title?.trim()}
                onclick={() => run(() => upsertCommand(record, editsOf()))}>save changes</button>
              <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "retire"}
          <div class="panel" style="--act:var(--overdue);--act-text:var(--overdue-text)">
            <div class="note">
              retiring takes this item off the belt — archive keeps its history;
              cancel marks it stood down and it can be restored later
            </div>
            <div class="save-row">
              <button class="btn-primary" disabled={busy}
                onclick={() => tap("archive", () => run(() => archiveCommand(record), { leave: true }))}>
                {armed === "archive" ? "tap again to archive" : "archive"}</button>
              {#if row.status === "active"}
                <button class="btn-quiet" disabled={busy}
                  onclick={() => tap("cancel", () => run(() => statusCommand(record, "cancelled")))}>
                  {armed === "cancel" ? "tap again to cancel" : "cancel item"}</button>
              {/if}
              <button class="cancel-link" onclick={() => { panel = null; armed = null; }}>never mind</button>
            </div>
          </div>
        {/if}

        {#if problem}
          <div class="problem" role="alert">{problem}</div>
        {/if}

        {#if row.notes}
          <h3>notes</h3>
          <p>{row.notes}</p>
        {:else if notesState}
          <h3>notes</h3>
          <p class={notesState === DAMAGED ? "failed" : "locked"}>{NOTES_WORDS[notesState]}</p>
        {/if}

        {#if row.docs.length}
          <div class="note"><b>{row.docs.length === 1
            ? "one document rides"
            : `${row.docs.length} documents ride`}</b>
            in the belt beside this item — the ringed bodies either side. click one to bring
            it in.</div>
        {:else}
          <div class="note">no documents yet — anything you attach, or mail in to your
            relay, takes a seat in the belt beside this item.</div>
        {/if}
      </article>
    {/if}
  </div>

  <!-- #1088: the reading card. Mounted only while a preview is on its way in
       or out — the fade needs the element there to fade, and mounting it
       unconditionally would hand a screen reader a dialog with nothing in
       it. `hidden` is never set while mounted: `previewOpen` alone drives
       the CSS transition (belt.css's `.readcard.open`), same law as
       create-v3's own `body.doc .readcard`. -->
  {#if previewDoc}
    {@const state = previewState}
    <aside class="glass readcard" id="readcard" class:open={previewOpen}
           class:snap={previewShowing} class:still={state !== "available"}
           class:rc-refused={state === "refused"}
           role="dialog" aria-label={previewDoc.name} tabindex="-1">
      <div class="pagebox">
        {#if state === "available" && !previewShowing}
          <!-- create-v3's focus block, verbatim: the reticle, the owner's
               words breathing while the page is on its way. -->
          <div class="focus">
            <svg class="reticle" viewBox="0 0 96 96" aria-hidden="true">
              <circle cx="48" cy="48" r="43" fill="none" stroke="var(--chart-line)" stroke-width="1"
                      stroke-dasharray="3 7" opacity=".8"/>
              <g class="sweep">
                <line x1="48" y1="5" x2="48" y2="14" stroke="var(--accent)" stroke-width="1.2" opacity=".8"/>
                <line x1="48" y1="82" x2="48" y2="91" stroke="var(--accent)" stroke-width="1.2" opacity=".35"/>
              </g>
              <g class="pull" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".7">
                <path d="M 26 18 H 18 V 26"/><path d="M 70 18 H 78 V 26"/>
                <path d="M 26 78 H 18 V 70"/><path d="M 70 78 H 78 V 70"/>
              </g>
              <circle cx="48" cy="48" r="16" fill="none" stroke="var(--chart-line)" stroke-width="1" opacity=".9"/>
              <circle cx="48" cy="48" r="1.8" fill="var(--accent)"/>
            </svg>
            <div class="focusline">Focusing on the anomaly</div>
            <div class="why">orbit is drawing the page it holds<br>nothing is changed, and nothing is assumed</div>
          </div>
        {:else if state === "scanning"}
          <div class="focus">
            <div class="plate scanning" aria-hidden="true">still scanning</div>
            <div class="focusline">Still scanning this file</div>
            <div class="why">the page comes once it scans clean<br>nothing is assumed</div>
          </div>
        {:else if state === "removed"}
          <div class="focus">
            <div class="plate removed" aria-hidden="true">being removed</div>
            <div class="focusline">Removed</div>
            <div class="why">orbit keeps it {previewDoc.deleteAfter ? `until ${previewDoc.deleteAfter}` : "for 30 days"}, then it is gone for good<br>restore puts it back exactly as it was</div>
          </div>
        {:else if state === "refused"}
          <div class="focus">
            <div class="plate" aria-hidden="true">refused</div>
            <div class="focusline">Orbit refused this file.</div>
            <div class="why">it did not pass what orbit checks before keeping a file<br>nothing here can be undone</div>
          </div>
        {:else if state === "undrawable"}
          <div class="focus">
            <div class="plate" aria-hidden="true">{previewDoc.plate}</div>
            <div class="focusline">Orbit could not draw a picture of this document.</div>
            <div class="why">the file is fine — scanned clean, and yours to download<br>orbit just could not turn it into a page to read here</div>
          </div>
        {/if}

        {#if state === "available"}
          <div class="topsheet">
            <div class="sheet">
              <img src={previewDoc.previewHref} alt="Page one of {previewDoc.name}"
                   onload={() => (previewImgLoaded = true)}
                   onerror={() => { previewImgLoaded = true; previewImgFailed = true; }} />
            </div>
          </div>
        {/if}
      </div>

      {#if state === "removed"}
        <div class="rcfoot">
          <button type="button" class="quiet" disabled={previewRestoring}
                  onclick={restorePreviewDoc}>restore</button>
        </div>
        {#if previewProblem}
          <div class="problem" role="alert">{previewProblem}</div>
        {/if}
      {:else if state === "undrawable"}
        <div class="rcfoot">
          <!-- Same cast the old docview card used: doc.href is a download
               endpoint, not a page route -- outside resolve()'s typed route
               union, but still the right runtime value. -->
          <a class="quiet" href={resolve(/** @type {"/home"} */ (previewDoc.href))} download>download</a>
        </div>
      {/if}
    </aside>
  {/if}
  </div>

  <!-- the nearest few per cent of the band: rubble that passes in FRONT -->
  <canvas id="fore" aria-hidden="true"></canvas>

  <!-- §14's "well-placed search box": the belt's way into the manifest -->
  <div class="find">
    <input id="find" type="search" placeholder="find an item — name, section, provider, document"
           aria-label="Find an item in the belt" autocomplete="off" spellcheck="false"
           aria-describedby="findnote" bind:this={findEl} oninput={onFind} onkeydown={onFindKey}>
    <div class="findnote" id="findnote">{findnote}</div>
    <!-- The hit list drops BESIDE the field, not beneath it: beneath it is
         where the card is, and the search must never cover the thing you are
         looking at. -->
    <div class="hits" class:open={Boolean(query.trim()) && bodies.length > 0}
         id="hits" role="listbox" aria-label="Matching items">
      {#if query.trim() && !hitList.length}
        <div class="none">no item, section, provider or document by that name</div>
      {:else}
        {#each hitList.slice(0, 7) as i (bodies[i].id)}
          <button type="button" class:pick={i === nearest}
                  onmousedown={(event) => event.preventDefault()}
                  onclick={() => goTo(i)}>
            <b>{bodies[i].kind === "doc" ? bodies[i].doc.name : bodies[i].label}</b>
            <small style="color:{bodies[i].tone}">{bodies[i].kind === "doc" ? "document" : bodies[i].t}</small>
            <small>{bodies[i].kind === "doc" ? bodies[i].sub : bodies[i].when}</small>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>
{/if}
