<script>
  import { onMount, tick } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import Chrome from "$lib/Chrome.svelte";
  import { fillStarTiles } from "$lib/sky.js";
  import { constellationPlanetsOf } from "$lib/data/chart.js";
  import { MAX_SECTIONS, deletionNameMatches, entriesLabel } from "$lib/data/household.js";
  import { FIELD, berthsOf, liftOf, roomOf, skyMap, toField } from "./room.js";
  import { consumeDoor } from "./door.js";
  import {
    addMember,
    decideJoinRequest,
    removeMember,
    requestHouseholdDeletion,
    transferOwnership,
    writeHouseholdIdentity,
    writeSections,
  } from "$lib/data/workspace.js";
  import "./household.css";

  /**
   * Household management (#410) — ONE system, seen by the person who owns it.
   * Built from design/v19/household-manage.html, ratified §15 ("90% there —
   * the actual form, everything is great; the background is the only issue"),
   * so the form is the mockup's rule for rule and the backdrop is the
   * family's standard drifting star tiles until §15 picks its successor.
   *
   * §15-2i — THERE IS NO ADMIN VARIANT OF THIS SCREEN. An instance admin who
   * needs an owner's powers over some household is handed THIS screen in its
   * owner state; admin surfaces carry admin-only functions. One drawing to
   * maintain, one set of words to get right.
   *
   * Every act lands on a route that already exists:
   *   rename / time zone / currency → POST /api/workspace/commands household.update
   *   sections                      → POST /api/workspace/commands sections.replace
   *   add / remove / leave          → /api/households/{id}/members  POST · DELETE
   *   hand the system over          → /api/households/{id}/members  PATCH
   *   joiners (§15-2g, here only)   → POST /api/join-requests/{id}
   *   request deletion              → POST /api/households/{id}/lifecycle
   *
   * 2f: restore-from-deletion and hard delete are ADMIN-ONLY and are drawn on
   * the admin panel. This screen keeps the request — two taps and the typed
   * name — and nothing else on that clock.
   */
  let { data } = $props();
  const v = $derived(data.household);

  /**
   * THE WAY BACK IS THE WAY YOU CAME (§15, owner ruling 2026-08-17).
   *
   * Read ONCE, here, while the screen is being created — not in onMount, or the
   * way back would be lettered "← SETTINGS" for a frame and then change its
   * mind in front of the reader. This route is client-rendered (ssr = false),
   * so component setup is already the browser. A save re-runs `load` and
   * replaces `data`; it does not re-create the component, so the door survives
   * everything that happens ON this screen and nothing that happens off it.
   */
  const door = consumeDoor();

  /* The identity fields (2c): three saves TO THE EYE over one bundled
     command. Local copies so a field can be edited, saved and left alone
     without the other two being retyped — the bundle carries them as they
     stand. */
  let form = $state({ name: "", timezone: "", currency: "" });
  let dirty = $state({ name: false, timezone: false, currency: false });
  let saved = $state({ name: false, timezone: false, currency: false });
  let identityProblem = $state(null);
  const savedTimers = {};

  /* The sections editor: one list, replaced whole. Rows are held locally
     because the whole list is the unit of saving — a half-edited list must
     never reach the route. */
  let rows = $state([]);
  let saidSections = $state(false);
  let sectionsProblem = $state(null);

  let handoverOpen = $state(false);
  let heir = $state(null);
  let saidHandover = $state(null);
  let saidLeft = $state(null);
  let saidJoin = $state(null);
  let membersProblem = $state(null);

  let confirming = $state(false);
  let typedName = $state("");
  let saidDoom = $state(false);
  let doomProblem = $state(null);

  /* Reset every local edit when the screen's data is replaced — a save
     reloads through the seam, and stale dirt on a field the server has since
     answered for would be a lie about what is stored. */
  $effect(() => {
    const household = data.household;
    form = { name: household.name, timezone: household.timezone, currency: household.currency };
    dirty = { name: false, timezone: false, currency: false };
    rows = household.sections.map((row) => ({ ...row }));
    heir = null;
  });

  /* The mockup's own lists. A household whose stored value is not among them
     keeps its own value at the head rather than being silently re-pointed at
     one that is — the select must never change what is stored by rendering. */
  const ZONES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "America/New York", "Australia/Sydney", "UTC"];
  const CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD"];
  const withCurrent = (list, current) => (list.includes(current) ? list : [current, ...list]);

  const shown = $derived(rows.filter((row) => !row.removed));
  const nameOk = $derived(deletionNameMatches(typedName, v.name));

  /* ── the two-tap protocol (§14) ─────────────────────────────────────────
     The first tap arms, the second fires, and an unfired arm relaxes on its
     own after five seconds so nothing is left cocked on the desk. */
  let armed = $state(null);
  let armTimer = null;
  function twoTap(key, fire) {
    if (armed === key) {
      clearTimeout(armTimer);
      armed = null;
      fire();
      return;
    }
    clearTimeout(armTimer);
    armed = key;
    armTimer = setTimeout(() => (armed = null), 5000);
  }

  /* ── the system (2c) ──────────────────────────────────────────────────── */
  function touch(field) {
    dirty[field] = true;
    saved[field] = false;
    clearTimeout(savedTimers[field]);
  }

  async function saveField(field) {
    identityProblem = null;
    try {
      await writeHouseholdIdentity(v.id, form);
      dirty[field] = false;
      saved[field] = true;
      clearTimeout(savedTimers[field]);
      savedTimers[field] = setTimeout(() => (saved[field] = false), 2600);
      await invalidateAll();
    } catch (error) {
      identityProblem = error?.message ?? String(error);
    }
  }

  /* ── sections (owner only, 2b) ────────────────────────────────────────── */
  function flipSection(row) {
    row.visible = !row.visible;
  }

  /* The hidden-not-removed law: only an empty section carries a × at all, so
     this can never be reached for one holding entries. */
  function dropSection(row) {
    if (!row.removable) return;
    row.removed = true;
  }

  function addSection() {
    if (shown.length >= MAX_SECTIONS) return;
    rows = [...rows, {
      /* A new section needs an id before it can be saved, and the engine's
         schema takes any string: a uuid keeps it unique without pretending to
         mean anything. Choosing a MARK for a new section is not drawn yet
         (the mockup's own open question), so it wears the neutral pen. */
      id: crypto.randomUUID(),
      name: "",
      icon: null,
      accent: null,
      visible: true,
      count: 0,
      removable: true,
      fresh: true,
    }];
  }

  async function saveSections() {
    sectionsProblem = null;
    saidSections = false;
    try {
      await writeSections(v.id, rows.map((row) => ({
        ...row,
        /* The engine's schema requires both; an undrawn choice is not a
           reason to send nothing, so a fresh row takes the family's first
           pen until 2b's open question is answered. */
        icon: row.icon ?? "home",
        accent: row.accent ?? "sage",
      })));
      saidSections = true;
      await invalidateAll();
    } catch (error) {
      sectionsProblem = error?.message ?? String(error);
    }
  }

  /* ── members ──────────────────────────────────────────────────────────── */
  async function act(run) {
    membersProblem = null;
    try {
      await run();
      await invalidateAll();
    } catch (error) {
      membersProblem = error?.message ?? String(error);
    }
  }

  const dropMember = (member) => act(() => removeMember(v.id, member.id));
  const putMember = (candidate) => act(() => addMember(v.id, candidate.id));

  function leave() {
    const me = v.you;
    if (!me) return;
    act(async () => {
      await removeMember(v.id, me.id);
      saidLeft = v.name;
    });
  }

  function handOver() {
    const taker = v.roster.find((member) => member.id === heir);
    if (!taker) return;
    act(async () => {
      await transferOwnership(v.id, taker.id);
      saidHandover = taker.name;
      handoverOpen = false;
    });
  }

  const decide = (request, action) =>
    act(async () => {
      await decideJoinRequest(request.id, action);
      if (action === "approve") saidJoin = request.name;
    });

  /* ── the danger line ──────────────────────────────────────────────────── */
  function openConfirm() {
    confirming = true;
    queueMicrotask(() => document.getElementById("delname")?.focus());
  }

  function requestDeletion() {
    doomProblem = null;
    /* The client's check only decides when the button wakes; the SERVER
       compares the exact name and is the only authority. */
    requestHouseholdDeletion(v.id, typedName)
      .then(() => (saidDoom = true))
      .catch((error) => (doomProblem = error?.message ?? String(error)));
  }

  /* The header ring, wearing this system's real due-state dots — the same
     truths its constellation shows on home (§12). Administration's mapping:
     the minisys ring at r40, shrunk to r13. */
  const TONE = { "--warm": "--warm", "--ok": "--ok", "--upcoming": "--upcoming", "--overdue": "--overdue" };
  const ringDots = $derived(
    constellationPlanetsOf(v.items ?? [], v.today).map(([x, y, r, tone]) => ({
      cx: 17 + x * 0.325,
      cy: 17 + y * 0.325,
      r: Math.max(1.2, r * 0.6),
      tone: TONE[tone] ?? "--ok",
    })),
  );

  /* ══════════════════════════════════════════════════════════════════════════
     H2 — INSIDE THIS SYSTEM (§15). The backdrop, and nothing but the backdrop:
     not one line below this point touches the desk above it.

     home.html carries one line in its galaxy renderer — "you never see your own
     constellation — you're inside it" — and this is that line, drawn.
     Everywhere else this household is a 40px ring with three dots on it, out in
     someone's sky; the little ring in this screen's own header IS that view.
     What is behind these cards is the SAME FIGURE at room scale, seen from the
     middle of it: the household's real entries, placed by the dial law
     (chart.js, through constellationOf), composed into the room by room.js.

     Where the mockup hand-placed the composition per fixture household, the
     rule solves it — see room.js. Everything measured here is measured for
     that rule: the runs of unprotected small type it must keep clear, and the
     panels a whisper label may not sit on.
     ══════════════════════════════════════════════════════════════════════════ */

  /* The chart key's four paints as FIELDS rather than filled planets: at room
     scale a body is a region of sky you are standing near, not a disc. The
     alphas keep the key's own order — ruby loudest, jade quietest — because
     that order is the information. */
  const PAINT = {
    overdue: ["--overdue", "hh-ruby"],
    "due-soon": ["--warm", "hh-amber"],
    upcoming: ["--upcoming", "hh-sky"],
    ok: ["--ok", "hh-jade"],
    unscheduled: ["--ok", "hh-jade"],
  };

  let stage = $state(null);
  let room = $state(null);
  let words = $state([]);
  /* Whether the type has landed — see the note on onMount. Nothing of this
     layer touches the DOM before it has. */
  let lettered = $state(false);
  /* The promise itself, kept for as long as the screen lives: see onMount. */
  let typeLanded = null;
  /* The descent's origin IS the sun, so scrolling is a fall INTO the system
     rather than a pan across it. In CSS pixels, because the sky's field is
     sliced about the centre and only the mapping knows where that puts it. */
  let origin = $state("43.1% 34%");

  /* The section figures: a section's entries joined in date order in that
     section's own accent (§15-2b — the mark travels with the entry). */
  const figures = $derived(
    (room?.stars?.length ? v.constellation.figures : []).map((figure) => ({
      id: figure.id,
      accent: figure.accent,
      points: figure.members
        .map((id) => room.stars.find((star) => star.id === id))
        .filter(Boolean)
        .map((star) => `${star.cx},${star.cy}`)
        .join(" "),
    })),
  );

  const rectsOf = (selector) =>
    [...(stage?.querySelectorAll(selector) ?? [])]
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);

  /**
   * The composition, measured and solved.
   *
   * KEEP-OUT is the type with no panel under it — the header's ring and its two
   * lines (the row itself is full-width but its ink is not, so the row's own
   * children are the guards), the way back and the account orb. Nothing of the
   * sky may be drawn on those.
   *
   * PANELS are the cards. They are NOT keep-out: glass with a backdrop-filter
   * over it is exactly what the figure is meant to compose behind. They are
   * guards for WORDS only, because a word under glass is unreadable ink that
   * costs the panel's own small type contrast for nothing — the mockup measured
   * that mistake at 2.70:1 → 2.43:1 and took it out.
   */
  function compose(constellation = v.constellation) {
    if (!stage) return;
    const map = skyMap(window.innerWidth, window.innerHeight);
    const keepOut = rectsOf("header.screen > *, .back, .orb").map((rect) => toField(rect, map));
    const panels = rectsOf(".card").map((rect) => toField(rect, map));
    room = roomOf({ marks: constellation.marks, ...FIELD, keepOut });
    words = berthsOf({ stars: room.stars, sun: room.sun, guards: [...keepOut, ...panels], ...FIELD });
    origin = `${(map.ox + room.sun[0] * map.k).toFixed(1)}px ${(map.oy + room.sun[1] * map.k).toFixed(1)}px`;
    /* The words are drawn from an estimate of their own width; only the browser
       knows what the font actually did, so the drawing is measured once it
       exists — after the DOM has caught up, and never before the type has
       landed (see onMount, which is the only thing that starts this). */
    tick().then(legible);
  }

  /**
   * A WORD IS DRAWN ONLY WHERE IT CAN BE READ.
   *
   * Every word in the backdrop — the entry names and the month names alike — is
   * tested against the real rectangles of the cards, the header, the chrome and
   * the edges of the frame, and any word that touches one is not drawn at all.
   * No word is ever cut in half by a card edge (which reads as a rendering
   * fault, not a backdrop), no word is ever laid unreadable under a panel, and
   * the answer stays right at widths nobody screenshotted.
   *
   * Measured at rest and on resize, never during a scroll: the composition
   * being judged is the one at scroll 0, and words winking out as you descend
   * would be its own kind of lie.
   */
  function legible() {
    if (!stage) return;
    const guards = rectsOf("header.screen > *, .back, .orb, .card");
    for (const word of stage.querySelectorAll(".consty text")) {
      word.style.display = "";
      const rect = word.getBoundingClientRect();
      const blocked =
        rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight ||
        guards.some((guard) =>
          rect.left < guard.right && rect.right > guard.left && rect.top < guard.bottom && rect.bottom > guard.top);
      word.style.display = blocked ? "none" : "";
      const leader = word.previousElementSibling;
      if (leader?.dataset?.leader) leader.style.display = blocked ? "none" : "";
    }
  }

  /**
   * THE DESCENT (§15, universal). You are already inside; scrolling takes you
   * DEEPER. The whole figure travels up and out as one rigid drawing — the sun
   * leaves early and the +1 year ring is the last thing over your head — because
   * a system does not stop existing when you stop looking at it. --lift is a
   * pure function of scrollTop (room.js), so scroll 0 is scroll 0 for ever, the
   * way back up is the way down reversed to the pixel, and reduced motion keeps
   * every bit of it: this is a POSITION, not an animation.
   */
  function descend() {
    if (!stage) return;
    const lift = liftOf(window.scrollY, window.innerHeight, document.documentElement.scrollHeight);
    stage.style.setProperty("--lift", lift.toFixed(4));
  }

  /**
   * THE SKY FOLLOWS THE SYSTEM. Walking from one household to another is a
   * client navigation on the same route: `load` runs again and the data is
   * replaced, but this component is not re-created — so the room is re-solved
   * from the household that is now on the desk. A backdrop still drawing the
   * system you just left would be the loudest possible lie on a screen whose
   * whole claim is that every mark is true.
   *
   * Keyed on the SKY ITSELF, in one string, and guarded by what was last drawn.
   * Composing writes state that this screen re-renders from, and a re-render is
   * a chance to run again: keyed on an object it would run for ever (measured —
   * Svelte's own effect_update_depth_exceeded), and keyed on the household's id
   * alone it would miss an entry whose date had moved. The signature is the
   * only thing the geometry can be a function of.
   */
  let drawn = null;
  $effect(() => {
    const marks = v.constellation.marks;
    const signature = `${v.id}#${marks.map((mark) => `${mark.id}:${mark.days}:${mark.halo}`).join("|")}`;
    if (!lettered || signature === drawn) return;
    drawn = signature;
    compose(v.constellation);
  });

  onMount(() => {
    fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));
    descend();
    /*
     * THE BACKDROP WAITS FOR THE FONTS, AND THEN FOR A FRAME.
     *
     * It waits for the fonts because the composition is solved against MEASURED
     * rectangles — where the header's two lines actually end — and those move
     * when the real faces arrive. This route is entirely client-rendered
     * (ssr = false), so its font loads only START at hydration: a room composed
     * before them would be composed against fallback metrics and would have to
     * jump once when they landed.
     *
     * It then waits for a FRAME, and that one is measured. Composing allocates
     * — a few thousand small objects between the room and the berths — and doing
     * that INSIDE document.fonts.ready's own callback runs it at the exact
     * moment the browser is settling that promise. Blink's pending `ready`
     * promise does not survive it: anything else awaiting the same signal is
     * handed "Resulting promise was garbage collected" instead of an answer,
     * which is how the fidelity gate met this — dependably broken from the
     * callback (4 runs in 4), dependably fine one frame later (10 in 10).
     * Measuring layout belongs in a frame anyway.
     */
    typeLanded = document.fonts?.ready ?? Promise.resolve();
    typeLanded.then(() => requestAnimationFrame(() => (lettered = true)));

    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; descend(); });
    };
    /* A resize re-measures the desk, so the room is re-solved for it: the desk
       keeps its 1060px column while the sky rescales around it, and which
       patches of sky are clear changes with the width. */
    const onResize = () => { compose(); descend(); };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onResize, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onResize);
    };
  });
</script>

<svelte:head><title>Orbit — {v.name}</title></svelte:head>

{#snippet mark(row)}
  <span class="mark" style="--sec:var({row.accent ? `--sec-${row.accent}` : "--ink-faint"})" aria-hidden="true">
    {#if row.icon === "home"}
      <svg width="17" height="17" viewBox="0 0 16 16">
        <path d="M2.6 7.7 8 3.1l5.4 4.6"/><path d="M4.3 7.4v5.6h7.4V7.4"/>
      </svg>
    {:else if row.icon === "vehicle"}
      <svg width="17" height="17" viewBox="0 0 16 16">
        <path d="M2.7 10.6V9.1l1.6-2.7h7.4l1.6 2.7v1.5"/>
        <circle cx="5.2" cy="10.7" r="1.15"/><circle cx="10.8" cy="10.7" r="1.15"/>
      </svg>
    {:else if row.icon === "device"}
      <svg width="17" height="17" viewBox="0 0 16 16">
        <rect x="4.2" y="2.7" width="7.6" height="10.6" rx="1.5"/>
        <path d="M6.7 11.6h2.6"/>
      </svg>
    {:else if row.icon === "service"}
      <svg width="17" height="17" viewBox="0 0 24 24" style="stroke-width:1.7">
        <path d="M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z"/>
      </svg>
    {:else if row.icon === "calendar"}
      <svg width="17" height="17" viewBox="0 0 16 16">
        <rect x="2.6" y="3.6" width="10.8" height="9.8" rx="1.4"/>
        <path d="M2.6 6.6h10.8M5.6 2.3v2.2M10.4 2.3v2.2"/>
      </svg>
    {:else}
      <!-- the neutral pen: a new section has no glyph of its own yet, and how
           one is CHOSEN is an open question, so nothing is invented here -->
      <svg width="17" height="17" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="4.6" stroke-dasharray="2 2"/>
      </svg>
    {/if}
    <i></i>
  </span>
{/snippet}

<div class="household-page" class:member={!v.canManage} bind:this={stage}>
<!-- your own system, drawn from the inside (§15 H2). Behind the dust, not in
     front of it: your system is the structure you are standing in, and the dust
     of the wider sky streams past nearer to the eye. Nothing in here is
     authored — every coordinate comes out of the household's own entries. -->
<div class="consty" style="transform-origin:{origin}" aria-hidden="true">
  <svg viewBox="0 0 {FIELD.width} {FIELD.height}" preserveAspectRatio="xMidYMid slice">
    <defs>
      <radialGradient id="hh-ruby"><stop offset="0" style="stop-color:var(--overdue)" stop-opacity=".24"/><stop offset=".55" style="stop-color:var(--overdue)" stop-opacity=".08"/><stop offset="1" style="stop-color:var(--overdue)" stop-opacity="0"/></radialGradient>
      <radialGradient id="hh-amber"><stop offset="0" style="stop-color:var(--warm)" stop-opacity=".20"/><stop offset=".55" style="stop-color:var(--warm)" stop-opacity=".07"/><stop offset="1" style="stop-color:var(--warm)" stop-opacity="0"/></radialGradient>
      <radialGradient id="hh-sky"><stop offset="0" style="stop-color:var(--upcoming)" stop-opacity=".18"/><stop offset=".55" style="stop-color:var(--upcoming)" stop-opacity=".06"/><stop offset="1" style="stop-color:var(--upcoming)" stop-opacity="0"/></radialGradient>
      <radialGradient id="hh-jade"><stop offset="0" style="stop-color:var(--ok)" stop-opacity=".15"/><stop offset=".55" style="stop-color:var(--ok)" stop-opacity=".05"/><stop offset="1" style="stop-color:var(--ok)" stop-opacity="0"/></radialGradient>
      <radialGradient id="hh-sun"><stop offset="0" style="stop-color:var(--sun)" stop-opacity=".10"/><stop offset=".4" style="stop-color:var(--sun)" stop-opacity=".032"/><stop offset="1" style="stop-color:var(--sun)" stop-opacity="0"/></radialGradient>
    </defs>
    {#if room}
      <g class="drift">
        <g class="rings">
          <!-- the sun: the dial's own disc and its core, at room scale. Held
               RIGHT down — a sun seen from inside its own system is a light,
               not a lamp. -->
          <circle cx={room.sun[0]} cy={room.sun[1]} r={room.rings.sun} fill="url(#hh-sun)"/>
          <circle cx={room.sun[0]} cy={room.sun[1]} r={(2.2 * room.scale).toFixed(1)}
                  style="fill:var(--sun-core)" opacity=".26"/>
          <!-- r=62 — the chart key's own words, "overdue: inside the ring", in
               the same dashed red the dial draws it in. A household with an
               overdue entry has a body in there; one without has an empty
               ring, which is also the truth. -->
          <circle cx={room.sun[0]} cy={room.sun[1]} r={room.rings.overdue} fill="none"
                  style="stroke:var(--overdue)" stroke-opacity=".17" stroke-width="1.4"
                  stroke-dasharray="{(3 * room.scale).toFixed(1)} {(5 * room.scale).toFixed(1)}"/>
          <!-- THE GIANT ONE, and it is not one ring: it is the dial's calendar
               band. r=150 is exactly +1 YEAR by the law, so the thing sweeping
               your room is a year, and you only ever see an arc of it. The
               months you are standing under are in the room with you; the rest
               are behind you. You cannot see all of your own system at once. -->
          <circle cx={room.sun[0]} cy={room.sun[1]} r={room.rings.year} fill="none"
                  style="stroke:var(--chart-line)" stroke-opacity=".72" stroke-width="2.4"/>
          <circle cx={room.sun[0]} cy={room.sun[1]} r={room.rings.rim} fill="none"
                  style="stroke:var(--chart-line-soft)" stroke-opacity=".8" stroke-width="1.2"/>
          {#each room.months as month (month.label)}
            <line x1={month.x1} y1={month.y1} x2={month.x2} y2={month.y2}
                  style="stroke:var(--chart-line)" stroke-opacity=".72" stroke-width="2.4"/>
          {/each}
          {#each room.months as month (month.label)}
            <text x={month.tx} y={month.ty} text-anchor="middle" font-size="31" letter-spacing="6"
                  style="fill:var(--chart-ink);font-family:var(--mono)" opacity=".2">{month.label}</text>
          {/each}
        </g>
        <g class="figures">
          {#each figures as figure (figure.id)}
            <polyline points={figure.points} fill="none"
                      style="stroke:var({figure.accent ? `--sec-${figure.accent}` : "--ink-faint"})"
                      stroke-opacity=".30" stroke-width="1.3" stroke-linecap="round"
                      stroke-dasharray="{room.scale.toFixed(1)} {(5 * room.scale).toFixed(1)}"/>
          {/each}
        </g>
        <g class="bodies">
          {#each room.stars as star (star.id)}
            <circle cx={star.cx} cy={star.cy} r={star.r} fill="url(#{PAINT[star.band][1]})"/>
            {#if star.band === "overdue"}
              <!-- the chart key's overdue ping, on any body that has earned it -->
              <circle cx={star.cx} cy={star.cy} r={(star.r * 1.27).toFixed(1)} fill="none"
                      style="stroke:var(--overdue)" stroke-opacity=".20" stroke-width="1.3"/>
            {/if}
            <circle cx={star.cx} cy={star.cy} r={Math.max(2.1, star.r * 0.115).toFixed(2)}
                    style="fill:var({PAINT[star.band][0]})" opacity=".55"/>
          {/each}
        </g>
        <!-- the whisper labels: what each star is and how far off it is, in the
             strings every other screen prints on the same bodies. Each one asks
             for a berth that is wholly readable and takes none if there isn't
             one (room.js berthsOf). -->
        <g class="labels">
          {#each words as word (word.id)}
            <line data-leader="1" x1={word.leader.x1} y1={word.leader.y1} x2={word.leader.x2} y2={word.leader.y2}
                  style="stroke:var(--chart-ink)" stroke-opacity=".38" stroke-width="1"/>
            <text x={word.x} y={word.y} text-anchor={word.anchor} font-size="11.5" letter-spacing="2.1"
                  style="fill:var(--chart-ink);font-family:var(--mono)" opacity=".72"
            >{word.text}<tspan opacity=".62">{word.tag}</tspan></text>
          {/each}
        </g>
      </g>
    {/if}
  </svg>
</div>

<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<!-- §15-2k: this screen hangs off the helm's memberships card, so the way back
     is to SETTINGS — unless you came in by the sun at the centre of the dial
     (ce86c7e), in which case it is your sky. door.js decides; absence of a
     marker is the helm, which is every deep link and every bookmark. -->
<Chrome user={v.user} current="settings" back={door.href} backLabel={door.label}
        role={`${v.name} · ${v.canManage ? "owner" : "member"}`} />

<div class="page">
  <header class="screen">
    <!-- the same ring administration draws for this system, wearing its real
         due-state dots (§12: nothing on it is decoration) -->
    <svg class="glyph" width="44" height="44" viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r="13" fill="none" style="stroke:var(--chart-line)"/>
      <circle cx="17" cy="17" r="2.6" style="fill:var({v.primary ? "--sun" : "--ink-mid"})"/>
      {#each ringDots as dot (dot.cx + "-" + dot.cy)}
        <circle cx={dot.cx} cy={dot.cy} r={dot.r} style="fill:var({dot.tone})" opacity=".8"/>
      {/each}
    </svg>
    <div>
      <h1>{v.name}</h1>
      <div class="sub">{v.subtitle}</div>
    </div>
  </header>

  <div class="cards">

    <!-- ── the system ────────────────────────────────────────────────────
         2c: three fields, three saves TO THE EYE — "it's more human". Each
         field owns its little save; you finish a thought and put it away.
         UNDERNEATH IT IS STILL ONE COMMAND: the client sends the bundled
         household.update carrying name + time zone + currency together. -->
    <div class="card c-system">
      <div class="cardhead"><h3>The system</h3></div>
      <div class="field" class:dirty={dirty.name}>
        <div class="lab">
          <label for="hhname">name</label>
          {#if v.canManage}
            <button class="fsave" class:done={saved.name} onclick={() => saveField("name")}>
              {saved.name ? "saved ✓" : "save"}</button>
          {/if}
        </div>
        <input id="hhname" maxlength="60" autocomplete="off" disabled={!v.canManage}
               bind:value={form.name} oninput={() => touch("name")}>
      </div>
      <div class="row2">
        <div class="field selwrap" class:dirty={dirty.timezone}>
          <div class="lab">
            <label for="hhzone">time zone</label>
            {#if v.canManage}
              <button class="fsave" class:done={saved.timezone} onclick={() => saveField("timezone")}>
                {saved.timezone ? "saved ✓" : "save"}</button>
            {/if}
          </div>
          <select id="hhzone" disabled={!v.canManage}
                  bind:value={form.timezone} onchange={() => touch("timezone")}>
            {#each withCurrent(ZONES, v.timezone) as zone (zone)}<option>{zone}</option>{/each}
          </select>
        </div>
        <div class="field selwrap" class:dirty={dirty.currency}>
          <div class="lab">
            <label for="hhcur">currency</label>
            {#if v.canManage}
              <button class="fsave" class:done={saved.currency} onclick={() => saveField("currency")}>
                {saved.currency ? "saved ✓" : "save"}</button>
            {/if}
          </div>
          <select id="hhcur" disabled={!v.canManage}
                  bind:value={form.currency} onchange={() => touch("currency")}>
            {#each withCurrent(CURRENCIES, v.currency) as code (code)}<option>{code}</option>{/each}
          </select>
        </div>
      </div>
      {#if v.canManage}
        <p class="note top">
          each field saves on its own — <b>name</b>, <b>time zone</b> and<br>
          <b>currency</b> are three small acts, not one form
        </p>
      {/if}
      <p class="note top">
        the name is what you type to delete this system later,<br>
        and what a joiner sees when they ask to come in
      </p>
      {#if !v.canManage}
        <p class="note top"><b>read-only</b> — only {v.owner?.name ?? "its owner"} can change this system</p>
      {/if}
      {#if identityProblem}<p class="problem">not saved — {identityProblem}</p>{/if}
    </div>

    <!-- ── sections: one list, replaced whole. OWNER-ONLY (2b) ─────────────
         A plain member never sees this card — not disabled, not greyed:
         absent. They meet sections where sections mean something, printed
         beside entries in the manifest. -->
    {#if v.canManage}
      <div class="card c-sections">
        <div class="cardhead">
          <h3>Sections</h3><span class="count">{shown.length} of {MAX_SECTIONS}</span>
        </div>

        <div>
          {#each shown as row (row.id)}
            <div class="sec" class:off={!row.visible} class:empty={row.removable}>
              {@render mark(row)}
              <input maxlength="30" aria-label="Section name" placeholder={row.fresh ? "name it" : null}
                     bind:value={row.name}>
              <span class="used">{entriesLabel(row.count)}</span>
              <button class="toggle" aria-pressed={row.visible} aria-label="{row.name} on the chart"
                      onclick={() => flipSection(row)}><i></i></button>
              <span class="state">{row.visible ? "shown" : "hidden"}</span>
              <button class="drop" title="remove" aria-label="Remove section"
                      onclick={() => dropSection(row)}>×</button>
            </div>
          {/each}
        </div>

        <button class="addsec" disabled={shown.length >= MAX_SECTIONS} onclick={addSection}>+ add a section</button>
        <div class="savebar">
          <button class="btn" onclick={saveSections}>save</button>
          <span class="note">the whole list saves at once</span>
        </div>
        {#if saidSections}
          <p class="said show">saved · the manifest prints the new names beside their entries</p>
        {/if}
        {#if sectionsProblem}<p class="problem">not saved — {sectionsProblem}</p>{/if}
        <p class="note top">
          each entry wears one section, printed beside it in the manifest,<br>
          and the mark travels with it. a section holding entries can be<br>
          <b>hidden</b>, never removed — its entries would have nowhere to sit.<br>
          <b>open question:</b> choosing a mark for a NEW section isn’t drawn yet.
        </p>
      </div>
    {/if}

    <!-- ── members: v3 moved this to the right-hand column, running its full
         height, so nothing sits under "the system" but sections ── -->
    <div class="card c-members">
      <div class="cardhead">
        <h3>Members</h3><span class="count">{v.memberCount} in this system</span>
      </div>

      <div class="roster">
        {#each v.roster as person (person.id)}
          <div class="memb">
            <span class="avatar" aria-hidden="true">{person.initials}</span>
            <!-- the space is written out: Svelte eats a leading one inside a
                 block, and the design's row reads "Tom Lawson · you" -->
            <b>{person.name}{#if person.you}{" "}<em>· you</em>{/if}</b>
            <span class="role" class:owner={person.role === "owner"}>{person.role}</span>
            {#if person.role === "owner" && person.you}
              <button class="ghost" aria-expanded={handoverOpen}
                      onclick={() => (handoverOpen = !handoverOpen)}>hand over →</button>
            {:else if v.canManage && person.role !== "owner"}
              <button class="ghost" class:armed={armed === `drop:${person.id}`}
                      onclick={() => twoTap(`drop:${person.id}`, () => dropMember(person))}>
                {armed === `drop:${person.id}` ? "tap again to remove" : "remove"}</button>
            {:else if person.you}
              <button class="ghost" class:armed={armed === "leave"}
                      onclick={() => twoTap("leave", leave)}>
                {armed === "leave" ? "tap again to leave" : "leave this system"}</button>
            {/if}
          </div>
        {/each}
      </div>
      {#if saidLeft}
        <p class="said show">you’ve left {saidLeft} · it becomes a label in your sky again, and you can ask to rejoin</p>
      {/if}
      {#if membersProblem}<p class="problem">{membersProblem}</p>{/if}

      {#if v.canManage}
        <!-- §11 + 2g: the owner decides who comes in, and this is the ONLY
             place the decision is offered. Administration's join-requests
             block is dropped — an instance admin who needs to answer one
             opens the household from the dial and answers it here. -->
        <div class="block">
          <h4>Waiting to come in</h4>
          {#each v.joinRequests as request (request.id)}
            <div class="joinreq">
              <span class="avatar" aria-hidden="true">{request.initials}</span>
              <p><b>{request.name}</b> asks to join <b>{v.name}</b>{request.waited ? ` · ${request.waited}` : ""}</p>
              <button class="yes" onclick={() => decide(request, "approve")}>approve</button>
              <button onclick={() => decide(request, "decline")}>decline</button>
            </div>
          {/each}
          {#if !v.joinRequests.length}
            <p class="restline note">
              nobody is asking just now — when someone picks this system out of<br>
              their sky and asks, they appear here, and <b>only</b> here (2g).
            </p>
          {/if}
          {#if saidJoin}
            <p class="said show">{saidJoin} is in · they see this system’s entries from their next sign-in</p>
          {/if}
        </div>

        <div class="block">
          <h4>Add someone who already has an account</h4>
          {#each v.candidates as candidate (candidate.id)}
            <div class="cand">
              <span class="avatar" aria-hidden="true">{candidate.initials}</span><b>{candidate.name}</b>
              <button class="ghost" onclick={() => putMember(candidate)}>add</button>
            </div>
          {/each}
          {#if !v.candidates.length}
            <p class="note">everybody with an account on this instance is already in this system.</p>
          {/if}
          <p class="note top">
            people sign in through your identity provider first, then an owner puts<br>
            them in a system. Nobody’s email address is shown here, only the name<br>
            they chose.<br>
            <b>email invitations come later</b> — deferred as its own package (#481).
          </p>
        </div>

        <!-- the handover: two deliberate steps, and the second asks twice -->
        <div class="handover" class:open={handoverOpen}>
          <h4>Hand this system over</h4>
          <div class="step">
            <span class="n">STEP ONE — WHO TAKES IT</span>
            {#each v.roster.filter((person) => person.role !== "owner") as person (person.id)}
              <label class="pick"><input type="radio" name="heir" value={person.id} bind:group={heir}> {person.name}</label>
            {/each}
            {#if v.roster.length < 2}
              <p class="note">there is nobody else in this system to hand it to yet.</p>
            {/if}
          </div>
          <div class="step">
            <span class="n">STEP TWO — CONFIRM</span>
            <div class="row">
              <button class="ghost" class:armed={armed === "handover"} disabled={!heir}
                      onclick={() => twoTap("handover", handOver)}>
                {armed === "handover"
                  ? "tap again to hand over"
                  : heir
                    ? `hand over to ${v.roster.find((person) => person.id === heir)?.name}`
                    : "hand over"}</button>
              <button class="ghost" onclick={() => (handoverOpen = false)}>cancel</button>
            </div>
          </div>
          <p class="note">
            you stay a member and keep everything you added.<br>
            only the new owner can hand it back — and an owner<br>
            can never leave a system, so this is the way out.
          </p>
          {#if saidHandover}
            <p class="said show">{saidHandover} owns {v.name} now · you’re a member</p>
          {/if}
        </div>

        <p class="note top foot">
          an owner can’t be removed and can’t leave — hand the system over first.
        </p>
      {:else}
        <p class="note top foot">
          <b>{v.owner?.name ?? "its owner"}</b> owns this system — they add and remove people.<br>
          you can leave whenever you like.
        </p>
      {/if}
    </div>

    <!-- ── THE DANGER ZONE ─────────────────────────────────────────────────
         Red rule, red wash, hazard ticks, red heading, and the button UP on
         the heading line at the right. The opener steps aside for the armed
         button so the card's one dangerous act always lives in the same
         place: the name must be typed exactly before that button wakes, and
         then it asks twice. -->
    {#if v.canManage}
      <div class="card c-danger dangercard">
        <div class="dangerhead">
          <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 2.2 16.4 15H1.6L9 2.2Z"/>
            <path d="M9 6.6v4.1"/><path d="M9 12.8v.05"/>
          </svg>
          <h3>The danger line</h3>
          <span class="spacer"></span>
          {#if !confirming}
            <button class="dangerbtn" onclick={openConfirm}>request deletion →</button>
          {:else}
            <button class="dangerbtn" class:armed={armed === "doom"} disabled={!nameOk || saidDoom}
                    onclick={() => twoTap("doom", requestDeletion)}>
              {armed === "doom" ? "tap again to schedule deletion" : "request deletion"}</button>
          {/if}
        </div>
        <div class="dangerbody">
          <p>
            <b class="red">Request deletion.</b> Everything in {v.name} — {v.entries}
            {v.entries === 1 ? "entry" : "entries"}, their
            documents, their history and every reminder still queued — stops the moment you
            ask. You have <b class="red">30 days</b> to change your mind; after that it is
            gone for good, and nothing on this machine can bring it back.
          </p>
          <p class="note">
            asking is all this screen does — the countdown,<br>
            the restore and the final hard delete are<br>
            instance-admin acts, drawn on the admin panel (2f).
          </p>
        </div>
        {#if confirming}
          <div class="confirm">
            <div class="field">
              <label for="delname">type the system’s name exactly to wake the button above</label>
              <input id="delname" placeholder={v.name} autocomplete="off" bind:value={typedName}>
            </div>
            <p class="note">
              the name is the first ask, the second tap is<br>
              the second — this is the one act with a clock on it.
            </p>
          </div>
        {/if}
        {#if saidDoom}
          <p class="said show">
            requested · {v.name} stops now, and is gone for good in 30 days ·
            changing your mind is an instance-admin act now — the admin panel carries the restore (2f)
          </p>
        {/if}
        {#if doomProblem}<p class="problem">not requested — {doomProblem}</p>{/if}
      </div>
    {/if}

    <!-- ── leaving: the member's second card, sitting UNDER the system in the
         left column, exactly where sections sits for an owner — so the member
         reads two tidy columns too, with no lone card across the foot -->
    {#if !v.canManage}
      <div class="card c-leaving">
        <div class="cardhead"><h3>Leaving</h3></div>
        <p style="font-size:13.5px;color:var(--ink-mid)">
          You can leave {v.name} whenever you like. Nothing you added goes with you —
          the entries belong to the system, not to you. It returns to your sky as a label,
          and you can ask to come back.
        </p>
        <p class="note top">only {v.owner?.name ?? "its owner"} can rename, restructure or delete this system.</p>
      </div>
    {/if}

  </div><!-- /cards -->
</div>
</div>
