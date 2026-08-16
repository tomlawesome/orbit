<script>
  import { onMount } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import Chrome from "$lib/Chrome.svelte";
  import { fillStarTiles } from "$lib/sky.js";
  import { constellationPlanetsOf } from "$lib/data/chart.js";
  import { MAX_SECTIONS, deletionNameMatches, entriesLabel } from "$lib/data/household.js";
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

  onMount(() => {
    fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));
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

<div class="household-page" class:member={!v.canManage}>
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<!-- §15-2k: this screen hangs off the helm's memberships card, so the way
     back is to SETTINGS rather than the sky. -->
<Chrome user={v.user} current="settings" back="/settings" backLabel="← SETTINGS"
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
