<script>
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Mark from "$lib/Mark.svelte";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import { mountReorder } from "$lib/pocket/reorder.js";
  import { standOnKeyboard } from "$lib/pocket/sheet.js";
  import { wake } from "$lib/pocket/wake.js";
  import { PEN_ORDER, inkOf, nextMark } from "$lib/marks.js";
  import { constellationPlanetsOf, hashId } from "$lib/data/chart.js";
  import { MAX_SECTIONS, deletionNameMatches, entriesLabel } from "$lib/data/household.js";
  import {
    addMember,
    decideJoinRequest,
    removeMember,
    requestHouseholdDeletion,
    sendInvitation,
    transferOwnership,
    withdrawInvitation,
    writeHouseholdIdentity,
    writeSections,
  } from "$lib/data/workspace.js";
  import PocketArchive from "./PocketArchive.svelte";
  import { changesLabel, changesOf, chipBodyOf, commandsFor, moved } from "./edits.js";
  import { roomOf } from "./room.js";

  /*
   * THE HOUSEHOLD ON A PHONE (#1122, proposal §2.10; owner decisions on
   * #1122 and design/owner-decisions.md §25). Rendered beside the desk's
   * cards and chosen by CSS (the switch at the foot), as create and home are.
   * On a phone Chrome.svelte draws the kit's top chrome, whose way back is
   * the desk's door (settings, or your sky).
   *
   * Top to bottom, one column on the household's own sky:
   *   the system's mark (home's chip, grown), its name and its one line
   *   MEMBERS first (3b, a trial): people, then who is knocking, then who
   *     is invited; `invite someone` and `add an existing account` at the foot
   *   THE SYSTEM: the name, the time zone and the currency
   *   SECTIONS (owner): long-press to reorder, a switch each
   *   THE ARCHIVE (owner): PocketArchive.svelte
   *   THE DANGER LINE (owner): delete, with the name typed exactly
   *
   * Row acts are revealed only by a left/right swipe (§25): no tap opens
   * them and nothing extra shows at rest. Keyboard: focus the row, ← or →.
   * Screen readers: each act is a real, visually hidden button named with
   * its object ("Remove Emma Lawson"). Knocks keep approve and decline on
   * show: they are the point of the row.
   *
   * Every edit to the system and its sections collects into one save bar
   * that rises from the foot while something is unsaved (2b, a trial):
   * "2 changes · undo · save". A failed save stays on the bar, in red,
   * until the next attempt (#1058).
   */

  /** @typedef {NonNullable<Awaited<ReturnType<typeof import('$lib/data/workspace.js').readHouseholdScreen>>>} HouseholdView */
  /** @typedef {import('$lib/data/workspace.js').SectionRow & { removed?: boolean, fresh?: boolean }} EditorRow */

  /** @type {{ household: HouseholdView }} */
  let { household } = $props();
  const v = $derived(household);

  /* ── the page's unsaved edits (2b) ────────────────────────────────────── */
  let identity = $state({ name: "", timezone: "", currency: "" });
  /** @type {EditorRow[]} */
  let rows = $state([]);
  let saving = $state(false);
  /** @type {string | null} */
  let problem = $state(null);

  function reset() {
    identity = { name: household.name, timezone: household.timezone, currency: household.currency };
    rows = household.sections.map((row) => ({ ...row }));
  }
  /* Whatever the server says replaces every local edit: a save reloads, and
     stale dirt on something it has since answered for would be a lie. */
  $effect(reset);

  const shown = $derived(rows.filter((row) => !row.removed));
  const changes = $derived(changesOf(
    { identity: { name: v.name, timezone: v.timezone, currency: v.currency }, sections: v.sections },
    { identity, sections: rows },
  ));
  const refusal = $derived(
    !identity.name.trim() ? "the system needs a name"
      : shown.some((row) => !row.name.trim()) ? "every section needs a name" : null,
  );
  const barUp = $derived(changes.length > 0 || problem !== null);

  async function save() {
    if (saving || refusal || !changes.length) return;
    const plan = commandsFor(changes);
    const count = changes.length;
    saving = true;
    problem = null;
    try {
      if (plan.identity) {
        await writeHouseholdIdentity(v.id, {
          name: identity.name.trim(), timezone: identity.timezone, currency: identity.currency,
        });
      }
      if (plan.sections) await writeSections(v.id, rows.map((row) => ({ ...row, name: row.name.trim() })));
      await invalidateAll();
      wake(`saved · ${changesLabel(count)}`);
    } catch (error) {
      problem = `not saved — ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`;
    } finally {
      saving = false;
    }
  }

  function undo() {
    problem = null;
    reset();
  }

  /* ── members ──────────────────────────────────────────────────────────── */
  /** @type {string | null} */
  let membersProblem = $state(null);
  /**
   * @param {() => Promise<unknown>} run
   * @param {string} said the wake, once it has worked
   */
  async function act(run, said) {
    membersProblem = null;
    try {
      await run();
      wake(said);
      await invalidateAll();
    } catch (error) {
      membersProblem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
      wake(membersProblem, { failure: true });
    }
  }

  const iOwn = $derived(v.you?.role === "owner");

  /* #481: the owner's row carries "leave" like every "you" row; it answers
     only the person it stops, while it stops them, then fades. */
  let ownerRefused = $state(false);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let refuseTimer;
  function ownerLeave() {
    ownerRefused = true;
    clearTimeout(refuseTimer);
    refuseTimer = setTimeout(() => (ownerRefused = false), 6000);
  }

  async function leave() {
    const me = v.you;
    if (!me) return;
    membersProblem = null;
    try {
      await removeMember(v.id, me.id);
      wake(`you’ve left ${v.name} · it’s a label in your sky again`);
      await goto(resolve("/home"));
    } catch (error) {
      membersProblem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    }
  }

  /**
   * The acts behind a person's row (§2.10, §25).
   * @param {HouseholdView["roster"][number]} person
   * @returns {import('$lib/pocket/row.js').RowAct[]}
   */
  function personActs(person) {
    if (person.you) {
      if (person.role === "owner") return [{ label: "leave", name: `Leave ${v.name}`, onact: ownerLeave }];
      return [{ label: "leave", name: `Leave ${v.name}`, danger: true, onact: leave }];
    }
    if (!v.canManage || person.role === "owner") return [];
    return [
      ...(iOwn ? [{ label: "hand over", name: `Hand ${v.name} over to ${person.name}`, tone: /** @type {const} */ ("accent"),
        onact: () => { heir = person; handoverOpen = true; } }] : []),
      { label: "remove", name: `Remove ${person.name}`, danger: true,
        onact: () => act(() => removeMember(v.id, person.id), `${person.name} is no longer in ${v.name}`) },
    ];
  }

  /** @type {HouseholdView["roster"][number] | null} */
  let heir = $state(null);
  let handoverOpen = $state(false);
  function handOver() {
    const taker = heir;
    if (!taker) return;
    handoverOpen = false;
    act(() => transferOwnership(v.id, taker.id), `${taker.name} owns ${v.name} now · you’re a member`);
  }

  /**
   * @param {HouseholdView["joinRequests"][number]} request
   * @param {"approve" | "decline"} action
   */
  const decide = (request, action) =>
    act(() => decideJoinRequest(request.id, action),
      action === "approve" ? `${request.name} is in ${v.name}` : `${request.name} was not let in`);

  /* ── invitations (#481) ───────────────────────────────────────────────── */
  let inviteOpen = $state(false);
  let inviteEmail = $state("");
  let inviting = $state(false);
  /** @type {string | null} */
  let inviteProblem = $state(null);

  /**
   * Send, and say what happened, honestly: the route answers the same whether
   * or not the address has an account, so the words never say who it is.
   * @param {string} email
   * @param {string} said
   */
  async function offer(email, said) {
    const address = email.trim();
    if (!address) return false;
    const { invitation } = await sendInvitation(v.id, address);
    wake(invitation.sentAt
      ? `${said} to ${invitation.email}`
      : `${invitation.email} is invited, but the mail could not be sent · try resend`,
    { failure: !invitation.sentAt });
    await invalidateAll();
    return true;
  }
  async function invite() {
    if (inviting) return;
    inviting = true;
    inviteProblem = null;
    try {
      if (await offer(inviteEmail, "invitation sent")) {
        inviteEmail = "";
        inviteOpen = false;
      }
    } catch (error) {
      inviteProblem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    } finally {
      inviting = false;
    }
  }

  /**
   * @param {HouseholdView["invitations"][number]} row
   * @returns {import('$lib/pocket/row.js').RowAct[]}
   */
  const invitationActs = (row) => v.canManage ? [
    { label: "resend", name: `Resend the invitation to ${row.email}`, tone: /** @type {const} */ ("accent"),
      onact: () => offer(row.email, "invitation sent again").catch((error) => wake(error?.message ?? String(error), { failure: true })) },
    { label: "withdraw", name: `Withdraw the invitation to ${row.email}`, danger: true,
      onact: () => act(() => withdrawInvitation(v.id, row.id), `the invitation to ${row.email} is withdrawn · its link no longer works`) },
  ] : [];

  /* ── adding someone who already has an account ────────────────────────── */
  let addOpen = $state(false);
  let addQuery = $state("");
  const candidates = $derived(v.candidates.filter((one) => one.name.toLowerCase().includes(addQuery.trim().toLowerCase())));
  /** @param {HouseholdView["candidates"][number]} candidate */
  function putMember(candidate) {
    addOpen = false;
    act(() => addMember(v.id, candidate.id), `${candidate.name} is in ${v.name}`);
  }

  /* ── the system's time zone and currency: a list sheet with a filter ─── */
  /** @type {"timezone" | "currency" | null} */
  let picking = $state(null);
  let pickOpen = $state(false);
  let pickQuery = $state("");
  const ZONES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "America/New_York", "Australia/Sydney", "UTC"];
  const CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD"];
  /** @param {"timeZone" | "currency"} key @param {string[]} fallback */
  const supported = (key, fallback) => {
    try { return Intl.supportedValuesOf?.(key) ?? fallback; } catch { return fallback; }
  };
  /** @type {Intl.DisplayNames | null} */
  let currencyNames = null;
  try { currencyNames = new Intl.DisplayNames(["en-GB"], { type: "currency" }); } catch { currencyNames = null; }
  /** @param {string} value */
  const pickLabel = (value) => picking === "currency" ? `${value} · ${currencyNames?.of(value) ?? value}` : value.replaceAll("_", " ");
  const options = $derived.by(() => {
    if (!picking) return [];
    const list = picking === "timezone" ? supported("timeZone", ZONES) : supported("currency", CURRENCIES);
    const current = identity[picking];
    const all = list.includes(current) ? list : [current, ...list];
    const query = pickQuery.trim().toLowerCase();
    return query ? all.filter((value) => pickLabel(value).toLowerCase().includes(query)) : all;
  });
  /** @param {"timezone" | "currency"} field */
  function pick(field) {
    picking = field;
    pickQuery = "";
    pickOpen = true;
  }
  /** @param {string} value */
  function choose(value) {
    if (picking) identity[picking] = value;
    pickOpen = false;
  }

  /* ── sections (owner only) ────────────────────────────────────────────── */
  /** @type {string} */
  let moveSaid = $state("");
  /** @param {number} from @param {number} to */
  function reorder(from, to) {
    const next = moved(shown, from, to);
    if (next === shown) return;
    rows = [...next, ...rows.filter((row) => row.removed)];
    moveSaid = `${next[to].name || "the section"} is now ${to + 1} of ${next.length}`;
  }
  /** @param {number} index @param {-1 | 1} direction */
  const moveBy = (index, direction) => reorder(index, index + direction);

  /** @param {EditorRow} row */
  const sectionName = (row) => row.name.trim() || "this section";

  /** @param {EditorRow} row */
  function flip(row) {
    row.visible = !row.visible;
  }

  /** @type {{ id: string | null, name: string, icon: string, shipped: boolean } | null} */
  let editing = $state(null);
  let editOpen = $state(false);
  /** @param {EditorRow} row */
  function editSection(row) {
    editing = { id: row.id, name: row.name, icon: row.icon, shipped: row.shipped };
    editOpen = true;
  }
  function newSection() {
    if (shown.length >= MAX_SECTIONS) return;
    /* #867: a new row wears a real mark from the moment it arrives. */
    editing = { id: null, name: "", icon: nextMark(shown.map((row) => row.icon)), shipped: false };
    editOpen = true;
  }
  /* The worn mark first, then every mark no OTHER row wears (#867). */
  const trayMarks = $derived.by(() => {
    if (!editing) return [];
    const mine = editing;
    const worn = new Set(shown.filter((row) => row.id !== mine.id).map((row) => row.icon));
    return [mine.icon, ...PEN_ORDER.filter((icon) => icon !== mine.icon && !worn.has(icon))];
  });
  /** @param {KeyboardEvent} event */
  function trayKey(event) {
    if (!editing || !["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const at = trayMarks.indexOf(editing.icon);
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const next = trayMarks[(at + (forward ? 1 : -1) + trayMarks.length) % trayMarks.length];
    editing.icon = next;
    queueMicrotask(() => document.getElementById(`hh-mark-${next}`)?.focus());
  }
  function keepSection() {
    const draft = editing;
    if (!draft || !draft.name.trim()) return;
    if (draft.id === null) {
      rows.push({
        id: crypto.randomUUID(), name: draft.name.trim(), icon: draft.icon, accent: inkOf(draft.icon),
        shipped: false, visible: true, count: 0, removable: true, fresh: true,
      });
    } else {
      const row = rows.find((one) => one.id === draft.id);
      if (row) {
        row.name = draft.name.trim();
        if (!row.shipped) { row.icon = draft.icon; row.accent = inkOf(draft.icon); }
      }
    }
    editOpen = false;
  }

  /**
   * @param {EditorRow} row
   * @returns {import('$lib/pocket/row.js').RowAct[]}
   */
  const sectionActs = (row) => [
    { label: "edit", name: `Edit ${sectionName(row)}`, tone: /** @type {const} */ ("accent"), onact: () => editSection(row) },
    /* The hidden-not-removed law: only an empty section can go. */
    ...(row.removable ? [{ label: "remove", name: `Remove ${sectionName(row)}`, danger: true,
      onact: () => { row.removed = true; } }] : []),
  ];

  /* ── the danger line ──────────────────────────────────────────────────── */
  let doomOpen = $state(false);
  let typedName = $state("");
  let saidDoom = $state(false);
  /** @type {string | null} */
  let doomProblem = $state(null);
  const nameOk = $derived(deletionNameMatches(typedName, v.name));
  async function requestDeletion() {
    doomProblem = null;
    try {
      /* The client's check only decides when the button wakes; the server
         compares the exact name and is the only authority. */
      await requestHouseholdDeletion(v.id, typedName);
      saidDoom = true;
      doomOpen = false;
      wake(`${v.name} is asked to be deleted · gone for good in 30 days`);
    } catch (error) {
      doomProblem = `not requested — ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`;
    }
  }

  /* ── the system's own mark and sky (home's chip, grown) ───────────────── */
  const planets = $derived(v.today ? constellationPlanetsOf(v.items ?? [], v.today) : []);
  /* The chip's body: its angle fixed by the id, its tone the nearest body's. */
  const tone = $derived.by(() => {
    const first = planets[0]?.[3] ?? "--ok";
    return ["--warm", "--upcoming", "--overdue"].includes(first) ? first : "--ok";
  });
  const chip = $derived(chipBodyOf(hashId(v.id), 15 * 5.5 / 8));
  const ringDots = $derived(planets.map(([x, y, r, dotTone]) => ({
    cx: 24 + x * 0.37, cy: 24 + y * 0.37, r: Math.max(1.3, r * 0.62), tone: dotTone,
  })));

  /* The household's year, seen from inside it (§15 H2), solved for the
     phone's own field and drawn faint behind the cards. No labels: at this
     width a word would be cut by the edge (§1.10). */
  const room = $derived.by(() => {
    try { return roomOf({ marks: v.constellation.marks, width: 400, height: 850 }); } catch { return null; }
  });
  /* The descent: scrolling lifts the year overhead. A position, not an
     animation, so reduced motion keeps it. Transform only. */
  /** @type {HTMLElement | undefined} */
  let art = $state();
  $effect(() => {
    if (!art) return;
    let frame = 0;
    const lift = () => {
      frame = 0;
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      art?.style.setProperty("--lift", Math.min(1, scrollY / max).toFixed(4));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(lift); };
    lift();
    addEventListener("scroll", onScroll, { passive: true });
    return () => { removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  });

  /* ── the bar stands on the keyboard (§1.11) ───────────────────────────── */
  /** @type {HTMLElement | undefined} */
  let root = $state();
  let barHeight = $state(0);
  $effect(() => (root ? standOnKeyboard(root) : undefined));

  const MARK_BUTTON = "hh-markbtn";
</script>

<div class="hh-pocket" class:member={!v.canManage} bind:this={root} style:--hh-bar="{barUp ? barHeight : 0}px"
     style:--hh-tone="var({tone})">
  <Sky />
  <div class="hh-art" aria-hidden="true" bind:this={art}>
    <div class="hh-glow"></div>
    {#if room}
      <svg viewBox="0 0 400 850" preserveAspectRatio="xMidYMid slice">
        <g class="hh-year">
          <circle cx={room.sun[0]} cy={room.sun[1]} r={room.rings.overdue} fill="none" style="stroke:var(--overdue)"
                  stroke-opacity=".2" stroke-width="1" stroke-dasharray="2 4"/>
          <circle cx={room.sun[0]} cy={room.sun[1]} r={room.rings.year} fill="none" style="stroke:var(--chart-line)"
                  stroke-opacity=".7" stroke-width="1.6"/>
          <circle cx={room.sun[0]} cy={room.sun[1]} r={room.rings.rim} fill="none" style="stroke:var(--chart-line-soft)"
                  stroke-opacity=".8" stroke-width=".8"/>
          {#each room.months as month (month.label)}
            <line x1={month.x1} y1={month.y1} x2={month.x2} y2={month.y2} style="stroke:var(--chart-line)"
                  stroke-opacity=".6" stroke-width="1.6"/>
          {/each}
          {#each room.stars as star (star.id)}
            <circle cx={star.cx} cy={star.cy} r={Math.max(2.4, star.r * 0.16).toFixed(2)} class="hh-star"
                    style="fill:var({star.band === 'overdue' ? '--overdue' : star.band === 'due-soon' ? '--warm' : star.band === 'upcoming' ? '--upcoming' : '--ok'})"/>
          {/each}
        </g>
      </svg>
    {/if}
  </div>

  <main class="hh-column" style:--hh-bar-room="{barUp ? barHeight + 16 : 0}px">
    <header class="hh-head hh-rise" style:--i="0">
      <svg class="hh-glyph" width="64" height="64" viewBox="0 0 48 48" aria-hidden="true">
        <circle class="hh-ring" cx="24" cy="24" r="15" fill="none"/>
        <circle cx="24" cy="24" r="2.6" style="fill:var({v.primary ? '--sun' : '--ink-mid'})"/>
        {#each ringDots as dot, i (i)}
          <circle class="hh-dot" style:--d="{i}" cx={dot.cx} cy={dot.cy} r={dot.r} style:fill="var({dot.tone})" opacity=".85"/>
        {/each}
        <g class="hh-chipbody">
          <circle cx={24 + chip.x} cy={24 + chip.y} r="3.4" style="fill:var(--bg)"/>
          <circle cx={24 + chip.x} cy={24 + chip.y} r="2.4" style="fill:var(--hh-tone)"/>
        </g>
      </svg>
      <div class="hh-named">
        <h1 class="p-title">{v.name}</h1>
        <p class="hh-sub">{v.subtitle}</p>
      </div>
    </header>

    <!-- MEMBERS FIRST (3b, a trial): on a phone the likely errand is a person. -->
    <h2 class="p-caps hh-rise" style:--i="1" id="hh-members-head">Members · {v.memberCount}</h2>
    <section class="p-card hh-flush hh-members hh-rise" style:--i="1" aria-labelledby="hh-members-head" data-hh="members">
      {#each v.roster as person (person.id)}
        <Row title="{person.name}{person.you ? ' · you' : ''}" trail={person.role}
             trailTone={person.role === "owner" ? "var(--accent-text)" : ""} acts={personActs(person)}>
          {#snippet mark()}<span class="p-avatar" class:owner={person.role === "owner"}>{person.initials}</span>{/snippet}
          {#snippet below()}
            {#if person.you && person.role === "owner" && ownerRefused}
              <p class="hh-moment warn" role="status">an owner can’t leave · hand the system over first</p>
            {:else if person.you && person.role !== "owner"}
              <p class="hh-moment leave">nothing you added goes with you · the entries stay with {v.name}</p>
            {/if}
          {/snippet}
        </Row>
      {/each}

      {#if v.joinRequests.length}
        <p class="p-caps hh-sub-head">Knocking</p>
        {#each v.joinRequests as request (request.id)}
          <Row title="{request.name} asked to join" meta={request.waited ?? ""}>
            {#snippet mark()}<span class="p-avatar hh-joiner">{request.initials}</span>{/snippet}
            {#snippet below()}
              <button class="p-pill act-ok" aria-label="Approve {request.name}" onclick={() => decide(request, "approve")}>approve</button>
              <button class="p-pill" aria-label="Decline {request.name}" onclick={() => decide(request, "decline")}>decline</button>
            {/snippet}
          </Row>
        {/each}
      {/if}

      {#if v.invitations.length}
        <p class="p-caps hh-sub-head">Invited</p>
        {#each v.invitations as invitation (invitation.id)}
          <Row title={invitation.email} acts={invitationActs(invitation)}
               meta={v.canManage ? `${invitation.failed ? "not sent" : `sent ${invitation.sent}`} · expires ${invitation.expires}` : `expires ${invitation.expires}`}>
            {#snippet mark()}<span class="hh-seat"></span>{/snippet}
          </Row>
        {/each}
      {/if}

      {#if membersProblem}<p class="p-error hh-inset" role="alert">{membersProblem}</p>{/if}
      {#if v.canManage}
        <div class="hh-foot">
          <button class="p-pill act-accent wide" onclick={() => { inviteProblem = null; inviteOpen = true; }}>invite someone</button>
          {#if v.candidates.length}
            <button class="p-pill wide" onclick={() => { addQuery = ""; addOpen = true; }}>add an existing account</button>
          {/if}
        </div>
      {/if}
    </section>

    <h2 class="p-caps hh-rise" style:--i="2" id="hh-system-head">The system</h2>
    <section class="p-card hh-rise" style:--i="2" aria-labelledby="hh-system-head" data-hh="system">
      {#if v.canManage}
        <label class="hh-label" for="hh-name">name</label>
        <input id="hh-name" class="hh-input" maxlength="60" autocomplete="off" enterkeyhint="done" bind:value={identity.name}>
        <div class="hh-flushrows">
          <Row title="time zone" trail={identity.timezone.replaceAll("_", " ")} onactivate={() => pick("timezone")}>
            {#snippet mark()}<span class="hh-kmark">◷</span>{/snippet}
          </Row>
          <Row title="currency" trail={identity.currency} onactivate={() => pick("currency")}>
            {#snippet mark()}<span class="hh-kmark">¤</span>{/snippet}
          </Row>
        </div>
      {:else}
        <div class="p-kv"><span>name</span><b>{v.name}</b></div>
        <div class="p-kv"><span>time zone</span><b>{v.timezone.replaceAll("_", " ")}</b></div>
        <div class="p-kv hh-last"><span>currency</span><b>{v.currency}</b></div>
      {/if}
    </section>

    {#if v.canManage}
      <h2 class="p-caps hh-rise" style:--i="3" id="hh-sections-head">Sections · {shown.length} of {MAX_SECTIONS}</h2>
      <section class="p-card hh-flush hh-sections hh-rise" style:--i="3" aria-labelledby="hh-sections-head" data-hh="sections">
        <div class="hh-seclist" use:mountReorder={{ onreorder: reorder }}>
          {#each shown as row, index (row.id)}
            <Row title={row.name || "unnamed section"} meta="{entriesLabel(row.count)} · {row.visible ? 'shown' : 'hidden'}"
                 acts={sectionActs(row)} onmove={(direction) => moveBy(index, direction)}>
              {#snippet mark()}<span class="hh-secmark" class:off={!row.visible}><Mark icon={row.icon} accent={row.accent} size={20} /></span>{/snippet}
              {#snippet end()}
                <button class="hh-switch" role="switch" aria-checked={row.visible}
                        aria-label="{sectionName(row)} shown on the chart" onclick={() => flip(row)}><i></i></button>
              {/snippet}
            </Row>
          {/each}
        </div>
        <p class="sr-only" role="status">{moveSaid}</p>
        <div class="hh-foot">
          <button class="p-pill act-accent wide" disabled={shown.length >= MAX_SECTIONS} onclick={newSection}>add a section</button>
          {#if shown.length >= MAX_SECTIONS}<p class="hh-note">{MAX_SECTIONS} is the most a system can hold</p>{/if}
        </div>
      </section>

      <div class="hh-rise" style:--i="4">
        <PocketArchive householdId={v.id} householdName={v.name} entries={v.entries} sections={shown.length} />
      </div>

      <section class="p-card danger hh-danger hh-rise" style:--i="5" aria-labelledby="hh-danger-head" data-hh="danger">
        <h2 class="hh-danger-head" id="hh-danger-head">
          <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 2.2 16.4 15H1.6L9 2.2Z"/><path d="M9 6.6v4.1"/><path d="M9 12.8v.05"/>
          </svg>
          The danger line
        </h2>
        {#if saidDoom}
          <p class="p-prose hh-doomsaid" role="status">
            requested · {v.name} stops now, and is gone for good in 30 days · an instance admin can turn this back until then
          </p>
        {:else}
          <p class="p-prose hh-doomsay">Deleting stops everything in {v.name} at once. There are 30 days to change your mind.</p>
          <button class="p-pill danger wide" onclick={() => { typedName = ""; doomProblem = null; doomOpen = true; }}>delete this system</button>
        {/if}
      </section>
    {/if}
  </main>

  <!-- THE SAVE BAR (2b): rises while something is unsaved, stands on the
       keyboard, keeps a failure on screen until the next attempt. -->
  <div class="hh-bar" class:up={barUp} inert={!barUp} bind:clientHeight={barHeight} data-hh="savebar">
    <div class="hh-bar-in">
      {#if problem}
        <p class="hh-problem" role="alert">{problem}</p>
      {:else if refusal}
        <p class="hh-refusal">{refusal}</p>
      {/if}
      <div class="hh-bar-row">
        <span class="hh-count" role="status">{saving ? "saving…" : barUp && changes.length ? changesLabel(changes.length) : ""}</span>
        <button class="p-pill" disabled={saving} onclick={undo}>undo</button>
        <button class="p-pill filled hh-save" disabled={saving || Boolean(refusal) || !changes.length} onclick={save}>
          {saving ? "saving…" : "save"}</button>
      </div>
    </div>
  </div>

  <Sheet bind:open={inviteOpen} size="callout" title="Invite someone">
    <form onsubmit={(event) => { event.preventDefault(); invite(); }}>
      <label class="hh-label" for="hh-invite">their email address</label>
      <input id="hh-invite" class="hh-input" type="email" inputmode="email" autocomplete="email" enterkeyhint="send"
             placeholder="name@example.com" bind:value={inviteEmail}>
      <p class="hh-note">the link admits only someone signed in with this exact address</p>
      <button class="p-pill filled wide hh-sheet-act" type="submit" disabled={!inviteEmail.trim() || inviting}>
        {inviting ? "sending…" : "send"}</button>
      {#if inviteProblem}<p class="p-error" role="alert">{inviteProblem}</p>{/if}
    </form>
  </Sheet>

  <Sheet bind:open={addOpen} size="list" title="Add an existing account">
    <input class="hh-input hh-filter" type="search" enterkeyhint="search" aria-label="Find an account by name"
           placeholder="find by name" bind:value={addQuery}>
    <div class="hh-flushrows">
      {#each candidates as candidate (candidate.id)}
        <Row title={candidate.name} trail="add" trailTone="var(--accent-text)" trailName="add {candidate.name}"
             onactivate={() => putMember(candidate)}>
          {#snippet mark()}<span class="p-avatar">{candidate.initials}</span>{/snippet}
        </Row>
      {:else}
        <p class="p-empty hh-inset">nobody here is called “{addQuery.trim()}”</p>
      {/each}
    </div>
  </Sheet>

  <Sheet bind:open={handoverOpen} size="callout" title="Hand {v.name} over?">
    {#if heir}
      <p class="p-prose hh-sheet-say">{heir.name} becomes its owner. You stay a member and keep everything you added.</p>
      <ArmButton label="hand over to {heir.name}" armedLabel="tap again to hand over" danger={false} wide
                 class="act-accent" onfire={handOver} />
    {/if}
  </Sheet>

  <Sheet bind:open={pickOpen} size="list" title={picking === "currency" ? "Currency" : "Time zone"}>
    <input class="hh-input hh-filter" type="search" enterkeyhint="search"
           aria-label={picking === "currency" ? "Find a currency" : "Find a time zone"}
           placeholder={picking === "currency" ? "find a currency" : "find a city or region"} bind:value={pickQuery}>
    <div class="hh-options" role="listbox" aria-label={picking === "currency" ? "Currencies" : "Time zones"}>
      {#each options as value (value)}
        <button class="hh-option" role="option" aria-selected={picking ? identity[picking] === value : false}
                onclick={() => choose(value)}>{pickLabel(value)}</button>
      {:else}
        <p class="p-empty hh-inset">nothing matches “{pickQuery.trim()}”</p>
      {/each}
    </div>
  </Sheet>

  <Sheet bind:open={editOpen} size="list" title={editing?.id ? `Edit ${editing.name.trim() || "section"}` : "Add a section"}>
    {#if editing}
      <form onsubmit={(event) => { event.preventDefault(); keepSection(); }}>
        <label class="hh-label" for="hh-secname">name</label>
        <input id="hh-secname" class="hh-input" maxlength="30" autocomplete="off" enterkeyhint="done"
               placeholder="name it" bind:value={editing.name}>
        {#if !editing.shipped}
          <p class="hh-label" id="hh-tray-head">mark · tap to swap</p>
          <div class="hh-tray" role="radiogroup" aria-labelledby="hh-tray-head" tabindex="-1" onkeydown={trayKey}>
            {#each trayMarks as icon (icon)}
              <Mark {icon} accent={inkOf(icon)} tag="button" type="button" role="radio" size={22} class={MARK_BUTTON}
                    id="hh-mark-{icon}" aria-label={icon} aria-checked={icon === editing.icon}
                    tabindex={icon === editing.icon ? 0 : -1} onclick={() => { if (editing) editing.icon = icon; }} />
            {/each}
          </div>
        {:else}
          <p class="hh-note">a shipped section keeps its mark</p>
        {/if}
        <button class="p-pill filled wide hh-sheet-act" type="submit" disabled={!editing.name.trim()}>
          {editing.id ? "done" : "add"}</button>
        <p class="hh-note">saved with the rest of your changes</p>
      </form>
    {/if}
  </Sheet>

  <Sheet bind:open={doomOpen} size="list" title="Delete {v.name}?">
    <p class="p-prose hh-sheet-say">
      Everything in {v.name} — {v.entries} {v.entries === 1 ? "entry" : "entries"}, their documents, their history
      and every reminder still queued — stops the moment you ask. You have <b class="hh-red">30 days</b> to change
      your mind; after that it is gone for good.
    </p>
    <label class="hh-label" for="hh-delname">type the system’s name exactly</label>
    <input id="hh-delname" class="hh-input" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"
           placeholder={v.name} bind:value={typedName}>
    <div class="hh-sheet-act">
      {#if nameOk}
        <ArmButton label="delete" armedLabel="tap again to delete {v.name}" wide onfire={requestDeletion} />
      {:else}
        <button class="p-pill danger wide" disabled>delete</button>
      {/if}
    </div>
    {#if doomProblem}<p class="p-error" role="alert">{doomProblem}</p>{/if}
  </Sheet>
</div>

<style>
  /* THE DIALECT SWITCH: the same query as $lib/pocket/media.js. The desk's
     cards and backdrop go; its chrome stays, because on a phone
     Chrome.svelte draws the kit's top chrome and the hatch. */
  .hh-pocket{display:none}
  @media (max-width:900px), (max-height:600px){
    .hh-pocket{display:block;position:relative;min-height:100dvh}
    :global(.household-page > :is(.consty, .sky, .vignette, .page)){display:none}
    :global(div.household-page){min-height:0}
  }

  /* THE HOUSEHOLD'S OWN SKY: the kit's stars, then this system's year at
     room scale and a glow in the tone of its nearest body, the tone its chip
     wears on home. Fixed, under the vignette's corners, transform only. */
  .hh-art{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.6}
  .hh-art svg{position:absolute;inset:-4% -4% auto;width:108%;height:108%;
    transform:translate3d(0, calc(var(--lift, 0) * -26vh), 0) scale(calc(1 + var(--lift, 0) * .08));
    transform-origin:30% 20%}
  .hh-year{animation:hh-turn 240s linear infinite;transform-origin:50% 50%;transform-box:view-box}
  @keyframes hh-turn{to{transform:rotate(6deg)}}
  .hh-star{opacity:.55}
  .hh-glow{position:absolute;left:-30%;top:-18%;width:130%;height:62%;
    background:radial-gradient(ellipse at 30% 40%, color-mix(in srgb, var(--hh-tone) 16%, transparent) 0%,
      color-mix(in srgb, var(--hh-tone) 5%, transparent) 42%, transparent 70%)}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .hh-art{opacity:.45}

  .hh-column{position:relative;z-index:2;box-sizing:border-box;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 8px) var(--p-gutter)
      calc(var(--hh-bar-room, 0px) + var(--p-kb, 0px) + 32px + env(safe-area-inset-bottom));
    transition:padding-bottom var(--p-rise) var(--p-ease)}

  /* The head: home's chip, grown. The ring arrives from the chip's size, the
     body takes its place, then the real due dots light one by one. */
  .hh-head{display:flex;align-items:center;gap:14px;margin:4px 0 8px}
  .hh-glyph{flex:none;overflow:visible}
  .hh-ring{stroke:var(--chart-line, var(--line));stroke-width:1.2}
  .hh-glyph{animation:hh-land 620ms var(--p-ease) both}
  .hh-chipbody{transform-origin:24px 24px;animation:hh-orbit 900ms var(--p-ease) both}
  .hh-dot{animation:hh-light 400ms ease both;animation-delay:calc(420ms + var(--d) * 70ms)}
  @keyframes hh-land{from{transform:scale(.32);opacity:0}}
  @keyframes hh-orbit{from{transform:rotate(-70deg)}}
  @keyframes hh-light{from{opacity:0}}
  :global([data-theme=retrograde]) .hh-chipbody{filter:drop-shadow(0 0 2.5px var(--bloom))}
  .hh-named{min-width:0}
  .hh-named .p-title{overflow-wrap:anywhere}
  .hh-sub{margin:6px 0 0;font:var(--p-type-meta)/1.5 var(--mono);color:var(--ink-quiet)}

  /* Cards arrive in turn, never in sync (§1.9). */
  .hh-rise{animation:hh-rise 420ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 60ms + 80ms)}
  @keyframes hh-rise{from{opacity:0;transform:translateY(10px)}}

  .hh-flush{padding:4px 0}
  .hh-flushrows{margin:8px calc(var(--p-card-pad) * -1) -8px}
  .hh-sub-head{margin:16px var(--p-gutter) 4px}
  .hh-inset{margin-left:var(--p-gutter);margin-right:var(--p-gutter)}
  .hh-foot{display:flex;flex-direction:column;gap:var(--p-pill-gap);padding:12px var(--p-gutter) 12px}

  /* A person knocking wears the desk's joiner ring: dashed, breathing. */
  .hh-joiner{border:1.5px dashed var(--accent);animation:p-breathe 2.4s ease-in-out infinite}
  /* An invitation's seat: the empty ring, no one in it yet. */
  .hh-seat{box-sizing:border-box;width:24px;height:24px;border-radius:50%;border:1.5px dashed var(--line)}
  .hh-kmark{font:var(--p-type-body)/1 var(--mono);color:var(--ink-quiet)}

  /* The two lines the members card says only when they apply (#481): the
     owner's refusal, and a member's consequence while their leave is armed. */
  .hh-moment{margin:0;font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-mid);flex:1 1 100%}
  .hh-moment.warn{color:var(--warm-text);animation:p-errin 200ms var(--p-ease) both}
  .hh-members :global(.p-row-below:not(:has(*))){display:none}
  .hh-members :global(.p-row:not(:has(.armed)) + .p-row-below:has(.hh-moment.leave)){display:none}
  .hh-members :global(.p-row:has(.armed) + .p-row-below .hh-moment.leave){animation:p-errin 200ms var(--p-ease) both}

  /* The system card. */
  .hh-label{display:block;font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ink-quiet);margin:0 0 6px}
  .hh-input{box-sizing:border-box;width:100%;min-height:48px;padding:0 14px;border-radius:12px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 55%, transparent);color:var(--ink);
    font:var(--p-type-body)/1.2 var(--ui)}
  .hh-input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  .hh-input::placeholder{color:var(--ink-quiet)}
  .hh-last{border-bottom:0}
  .hh-note{margin:8px 0 0;font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-quiet)}

  /* A section's mark, the desk's drawing (household.css): the pen line in
     ink, one small dot in the section's colour. */
  :is(.hh-secmark, .hh-tray) :global(:is(.mark, .hh-markbtn)){position:relative;display:grid;place-items:center}
  :is(.hh-secmark, .hh-tray) :global(:is(.mark, .hh-markbtn) svg){display:block;fill:none;stroke:var(--ink-mid);
    stroke-width:1.15;stroke-linecap:round;stroke-linejoin:round;opacity:.9}
  :is(.hh-secmark, .hh-tray) :global(:is(.mark, .hh-markbtn) i){position:absolute;right:-1px;bottom:0;width:6px;height:6px;
    border-radius:50%;background:var(--sec);opacity:.92}
  .hh-tray :global(.hh-markbtn i){right:9px;bottom:9px}
  /* Sections: the mark dims with its row when the section is hidden. */
  .hh-secmark{display:grid;place-items:center;transition:opacity 150ms}
  .hh-secmark.off{opacity:.4}
  .hh-sections :global(.p-row:has(.hh-secmark.off) .title){color:var(--ink-quiet)}
  /* The switch: 52x32 drawn, 44 tall hit (§1.7). */
  .hh-switch{appearance:none;box-sizing:border-box;width:56px;height:var(--p-hit);padding:0;border:0;background:none;
    display:grid;place-items:center;cursor:pointer;-webkit-tap-highlight-color:transparent;margin-right:-6px}
  .hh-switch i{position:relative;box-sizing:border-box;width:46px;height:28px;border-radius:14px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 60%, transparent);
    transition:background-color var(--p-spring),border-color var(--p-spring)}
  .hh-switch i::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
    background:var(--ink-quiet);transition:transform var(--p-spring) var(--p-ease),background-color var(--p-spring)}
  .hh-switch[aria-checked=true] i{background:color-mix(in srgb, var(--accent) 30%, transparent);border-color:var(--accent)}
  .hh-switch[aria-checked=true] i::after{transform:translateX(18px);background:var(--accent)}
  :global([data-theme=retrograde]) .hh-switch[aria-checked=true] i::after{box-shadow:0 0 8px var(--bloom)}
  .hh-switch:focus-visible{outline:none}
  .hh-switch:focus-visible i{outline:2px solid var(--accent);outline-offset:2px}

  /* The mark tray (#867): 44px marks, four to a line. */
  .hh-tray{display:grid;grid-template-columns:repeat(4, var(--p-hit));justify-content:space-between;gap:8px;margin:0 0 4px}
  .hh-tray :global(.hh-markbtn){appearance:none;width:var(--p-hit);height:var(--p-hit);border-radius:12px;
    border:1px solid var(--line-soft);background:var(--panel);display:grid;place-items:center;cursor:pointer}
  .hh-tray :global(.hh-markbtn[aria-checked=true]){border-color:var(--accent);
    background:color-mix(in srgb, var(--accent) 14%, transparent)}
  .hh-tray :global(.hh-markbtn:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
  form .hh-label:not(:first-child){margin-top:16px}

  /* The danger line: the kit's danger card, heading on its own line. */
  .hh-danger{margin-top:var(--p-group-above)}
  .hh-danger-head{display:flex;align-items:center;gap:8px;margin:6px 0 8px;
    font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    color:var(--overdue-text)}
  .hh-danger-head svg{fill:none;stroke:var(--overdue-text);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  .hh-doomsay{color:var(--ink-mid);margin:0 0 12px}
  .hh-doomsaid{color:var(--overdue-text);margin:0}
  .hh-red{color:var(--overdue-text)}

  /* Sheets' insides. */
  .hh-sheet-say{color:var(--ink-mid);margin:4px 0 16px}
  .hh-sheet-act{margin-top:16px}
  .hh-filter{margin:4px 0 8px}
  .hh-options{display:flex;flex-direction:column}
  .hh-option{appearance:none;min-height:var(--p-row-min);padding:0 4px;border:0;border-bottom:1px solid var(--line-soft);
    background:none;text-align:left;font:var(--p-type-body)/1.3 var(--ui);color:var(--ink);cursor:pointer}
  .hh-option[aria-selected=true]{color:var(--accent-text);font-weight:600}
  .hh-option:active{background:var(--panel-raised)}
  .hh-option:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .p-pill:disabled{opacity:.45;cursor:default;box-shadow:none}

  /* THE SAVE BAR (2b): off the foot and unseen at rest; rises 300ms. The
     one blurred fixed layer on this screen (§5.3). */
  .hh-bar{position:fixed;z-index:15;left:0;right:0;bottom:var(--p-kb, 0px);
    background:color-mix(in srgb, var(--panel-raised) 88%, transparent);backdrop-filter:blur(16px);
    border-top:1px solid var(--line-soft);box-shadow:0 -12px 32px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.05);
    padding:10px var(--p-gutter) calc(10px + env(safe-area-inset-bottom));
    transform:translateY(calc(100% + 12px));visibility:hidden;
    transition:transform var(--p-rise) var(--p-ease),visibility 0s var(--p-rise)}
  .hh-bar.up{transform:none;visibility:visible;transition-delay:0s}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .hh-bar{
    box-shadow:inset 0 1px 0 rgba(255,255,255,.78), 0 -12px 28px rgba(48,66,98,.10)}
  .hh-bar-in{max-width:var(--p-column);margin:0 auto}
  .hh-bar-row{display:flex;align-items:center;gap:var(--p-pill-gap)}
  .hh-count{flex:1;min-width:0;font:var(--p-type-meta)/1.3 var(--mono);color:var(--ink-mid)}
  .hh-save{min-width:96px}
  .hh-refusal,.hh-problem{margin:0 0 8px;font:var(--p-type-meta)/1.4 var(--ui)}
  .hh-refusal{color:var(--ink-mid)}
  .hh-problem{color:var(--overdue-text);animation:p-errin 200ms var(--p-ease) both}

  @media (prefers-reduced-motion:reduce){
    .hh-year,.hh-glyph,.hh-chipbody,.hh-dot,.hh-rise,.hh-joiner,.hh-moment.warn,.hh-problem{animation:none}
    .hh-bar,.hh-column{transition:none}
  }
</style>
