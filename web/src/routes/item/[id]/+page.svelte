<script>
  import { onMount, tick } from "svelte";
  import { goto, invalidateAll, replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { mountTiledSky } from "$lib/sky.js";
  import { every, longDate, money } from "$lib/format.js";
  import { WorkspaceError, applyCommand } from "$lib/data/workspace.js";
  import { beltManifestOf } from "$lib/data/belt.js";
  import {
    archiveCommand, completeCommand, nextDateAfter, rescheduleCommand,
    snoozeCommand, statusCommand, upsertCommand,
  } from "$lib/data/commands.js";
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
     the band. It forks to its own component, imported lazily so the belt's
     page never loads item.css — see Suggestion.svelte. */
  const suggestionView =
    data.kind === "suggestion" ? import("./Suggestion.svelte").then((m) => m.default) : null;

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
      today: data.today,
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
      replaceState(resolve("/item/[id]", { id: encodeURIComponent(itemId) }), {});
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
        ? `${itemCount} items · ← → steps in date order`
        : hitList.length
          ? `${hitList.length} of ${itemCount} lit · enter centres the nearest`
          : "nothing matches · the belt keeps its shape",
  );

  /** @param {KeyboardEvent} event */
  function onFindKey(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (nearest >= 0) belt?.centre(nearest);
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
  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key === "Escape" && panel) { panel = null; armed = null; return; }
    if (typing(event.target)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const next = stepFrom(bodies, selected, bloom, -1);
      if (next >= 0) belt?.centre(next);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = stepFrom(bodies, selected, bloom, 1);
      if (next >= 0) belt?.centre(next);
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
   * @param {() => unknown} build  the command to send
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
      problem = error instanceof Error ? error.message : String(error);
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

<svelte:window onkeydown={onKeydown} />

<svelte:head>
  <title>{data.kind === "belt" ? (row?.title ?? "Item") : "Suggestion"} — Orbit</title>
</svelte:head>

{#if data.kind === "suggestion"}
  {#await suggestionView then Suggestion}
    <Suggestion item={data.item} />
  {/await}
{:else}
<div class="belt-page" bind:this={root}>
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
    <g id="ends" aria-hidden="true"></g>
    <g id="seats"></g>
    <g id="caps"></g>
  </svg>

  <!-- the card, riding at the apex -->
  <div class="cardwrap" id="cardwrap">
    {#if !bodies.length}
      <!-- The empty household. The band is still a belt — ambient rock and
           dust, thinner, because nothing here has swept anything yet. -->
      <article class="glass item-card">
        <h2>Nothing in orbit yet</h2>
        <div class="sub">{data.household?.name ?? "your system"} · an empty manifest</div>
        <div class="note">the belt IS the manifest. every item you add takes a seat in it,
          in the order it comes due — sooner to the left, later to the right — and the one
          you are looking at rides at the apex as this card. add the first and the band has
          something to carry.</div>
        <h4>start</h4>
        <div class="acts" role="group" aria-label="Actions">
          <button style="--act:var(--accent)" onclick={() => goto(resolve("/create"))}>add an item</button>
          <button style="--act:var(--upcoming)" onclick={() => goto(resolve("/inbox"))}>mail something in</button>
        </div>
        <a class="back" href={resolve("/home")}>← back to your orbit</a>
      </article>
    {:else if cardBody?.kind === "doc" && row}
      <!-- A document shows what Orbit honestly holds: what the file is, when
           it arrived, that it scanned clean, and the original in your hands. -->
      <article class="glass item-card">
        <div class="docview">
          <div class="plate" aria-hidden="true">{cardBody.doc.plate}</div>
          <div class="docbody">
            <h3>{cardBody.doc.name}</h3>
            <div class="sub">document · attached to {row.title}</div>
            <div class="kv"><span>added</span><b>{cardBody.doc.added}</b></div>
            <div class="kv"><span>size</span><b>{cardBody.doc.size}</b></div>
            <div class="kv"><span>kind</span><b>{cardBody.doc.type}</b></div>
            <div class="kv"><span>scan</span>
              {#if cardBody.doc.clean}<b class="clean">scanned clean</b>
              {:else}<b>{cardBody.doc.scan ?? "not scanned"}</b>{/if}</div>
            <div class="getrow">
              <a class="btn-primary" href={resolve(cardBody.doc.href)} download>download the original</a>
            </div>
          </div>
        </div>
        <!-- #476 SEAM: when Orbit can render page one, that render fills this
             half of the card and the plate retires. The endpoint exists —
             GET /api/documents/&lt;id&gt;/preview — and this screen deliberately does
             NOT call it yet: v1 is details and the original (owner, §15), and
             the preview lands once #476's container evidence closes. Until it
             can, the screen says what it holds and hands over the file — it
             does not draw a page it has never seen. -->
        <div class="note">the page itself is not something Orbit holds yet — until it does,
          this is the honest read, and the original is one click away.<br>
          <b>{row.title}</b> is the ringed body beside you in the belt.</div>
        <button class="back" onclick={() => belt?.centreById(row.id)}>← back to {row.title}</button>
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
        <div class="kv"><span>due</span><b class={row.urg}>{row.t} · {row.longWhen}</b></div>
        {#if row.snoozedUntil}
          <div class="kv"><span>snoozed until</span><b>{longDate(row.snoozedUntil)}</b></div>
        {/if}
        {#if row.status !== "active"}
          <div class="kv"><span>status</span><b>{row.status}</b></div>
        {/if}
        {#if row.months}
          <div class="kv"><span>orbital period</span><b>{every(row.months)}</b></div>
        {/if}
        <div class="kv"><span>cost</span><b>{money(row.cost, row.currency, row.costIsEstimate)}</b></div>
        {#if row.provider}
          <div class="kv"><span>provider</span><b>{row.provider}</b></div>
        {/if}
        {#if row.reference}
          <div class="kv"><span>reference</span><b>{row.reference}</b></div>
        {/if}
        {#if row.remind.length}
          <div class="kv"><span>reminders</span><b>{remindOf(row.remind)}</b></div>
        {/if}

        <h4>actions</h4>
        <div class="acts" role="group" aria-label="Item actions">
          {#if row.status === "active"}
            <button style="--act:var(--ok)" aria-pressed={panel === "complete"}
                    onclick={() => open("complete", record)}>complete</button>
            <button style="--act:var(--upcoming)" aria-pressed={panel === "reschedule"}
                    onclick={() => open("reschedule", record)}>reschedule</button>
            <button style="--act:var(--warm)" aria-pressed={panel === "snooze"}
                    onclick={() => open("snooze", record)}>snooze</button>
            <button style="--act:var(--accent)" aria-pressed={panel === "edit"}
                    onclick={() => open("edit", record)}>edit</button>
            <button style="--act:var(--overdue)" aria-pressed={panel === "retire"}
                    onclick={() => open("retire", record)}>retire</button>
          {:else}
            <button style="--act:var(--ok)" disabled={busy}
                    onclick={() => run(() => statusCommand(record, "active"))}>restore</button>
            {#if row.status !== "archived"}
              <button style="--act:var(--overdue)" aria-pressed={panel === "retire"}
                      onclick={() => open("retire", record)}>retire</button>
            {/if}
          {/if}
        </div>

        {#if panel === "complete"}
          <div class="panel" style="--act:var(--ok)">
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
                <input id="a-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional"></div>
            </div>
            <div class="field"><label for="a-cnotes">notes</label>
              <input id="a-cnotes" bind:value={form.notes} placeholder="optional"></div>
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
          <div class="panel" style="--act:var(--upcoming)">
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
          <div class="panel" style="--act:var(--warm)">
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
          <div class="panel" style="--act:var(--accent)">
            <div class="field"><label for="e-title">title</label>
              <input id="e-title" bind:value={form.title}></div>
            <div class="row2">
              <div class="field"><label for="e-provider">provider</label>
                <input id="e-provider" bind:value={form.provider} placeholder="optional"></div>
              <div class="field"><label for="e-reference">reference</label>
                <input id="e-reference" bind:value={form.reference} placeholder="optional"></div>
            </div>
            <div class="row2">
              <div class="field mono"><label for="e-cost">cost</label>
                <input id="e-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional"></div>
              <div class="field"><label for="e-due">due date</label>
                <input id="e-due" type="date" bind:value={form.dueDate}></div>
            </div>
            <div class="field"><label for="e-recur">orbital period (months)</label>
              <input id="e-recur" inputmode="numeric" bind:value={form.recurrenceMonths} placeholder="optional"></div>
            <div class="field"><label for="e-notes">notes</label>
              <textarea id="e-notes" rows="3" bind:value={form.notes} placeholder="optional"></textarea></div>
            <div class="save-row">
              <button class="btn-primary" disabled={busy || !form.title?.trim()}
                onclick={() => run(() => upsertCommand(record, editsOf()))}>save changes</button>
              <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
            </div>
          </div>
        {/if}

        {#if panel === "retire"}
          <div class="panel" style="--act:var(--overdue)">
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
          <h4>notes</h4>
          <p>{row.notes}</p>
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
        <a class="back" href={resolve(`/home#${row.id}`)}>← back to your orbit</a>
      </article>
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
                  onclick={() => belt?.centre(i)}>
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
