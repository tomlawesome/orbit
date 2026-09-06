<script>
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { addMember, commandMailbox, readAdminScreen } from "$lib/data/workspace.js";
  import { constellationPlanetsOf, galaxyOf } from "$lib/data/chart.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";
  import { mountStation } from "$lib/backdrops/station.js";
  import Chrome from "$lib/Chrome.svelte";
  import "./administration.css";

  /**
   * Administration — mission control (#465). Built from
   * design/v19/administration.html (ratified §13): the instance from above.
   * Admins see everything by design (§11); admins can place anyone anywhere.
   * People come from the real /api/admin/users route; ownership and
   * membership counts are the #453 epic's admin surface and render from the
   * fixture until it lands. Each system's ring wears its REAL due-state dots
   * — the same truths its constellation shows on home (§12). §15: the relay
   * lives in one place — the helm's card; what stands here is MAIL
   * MACHINERY, joined to operations in a single panel.
   *
   * §15-2g: JOIN REQUESTS DO NOT APPEAR HERE. They live in household
   * management only — admin surfaces are for admin-only functions, and an
   * instance admin who needs owner powers simply sees the owner's household
   * screen for the system chosen on the dial. The /api/join-requests routes
   * and their server code stay put; household-manage will consume them when
   * it is built.
   *
   * The living station backdrop (#472/#475, §14) is $lib/backdrops/station.js,
   * ported from design/v19/administration-iss.html — this file only mounts
   * it and tears it down, the same shape as create/+page.svelte and
   * settings/mail/+page.svelte. Its households come through the same seam
   * home and create draw their own skies from (galaxyOf), and its caption's
   * real facts (collection domain, systems aboard, crew) come off this
   * screen's own data rather than the sheet's hard-coded literals.
   */
  /** @type {{ data: { fixtures: boolean } }} */
  let { data } = $props();
  /** @type {Awaited<ReturnType<typeof readAdminScreen>> | null} */
  let view = $state(null);
  /* The template only calls into `view` from inside `{#if view}`, but that
     guard doesn't reach into these standalone functions' closures, so this
     asserts what the call sites already guarantee rather than duplicating
     the check. */
  const need = () => /** @type {NonNullable<typeof view>} */ (view);
  /** @type {?HTMLDivElement} */
  let backdropRoot = null;

  /** @param {string} name */
  const initialsOf = (name) =>
    name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();

  /* §11 (#453): direct placement — it lands on the real route and refreshes
     the screen with the server's answer. Deciding join requests is NOT an
     admin-screen function (§15-2g). */
  /** @type {string | null} */
  let busy = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  /** @type {string | null} */
  let placing = $state(null); // user id whose system picker is open
  /**
   * @param {string} userId
   * @param {string} householdId
   */
  async function place(userId, householdId) {
    busy = userId;
    problem = null;
    try {
      await addMember(householdId, userId);
      placing = null;
      view = await readAdminScreen();
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    } finally {
      busy = null;
    }
  }
  /* §15 mail machinery, made real (#743, ADR-0017 slice 2). The instance has
     ONE admin-owned mailbox; this is where it is set, checked, rotated,
     removed and switched on or off.

     Two rules the markup below has to keep. The password is WRITE-ONLY: it is
     typed into a field that is never populated from the server, sent once,
     and cleared — nothing that comes back carries it, so "is a credential
     stored?" is answered by `hasPassword`, never by a value. And an
     administrator never sees a member's relay address: `aliasPattern` is the
     SHAPE addresses take, with a placeholder where the member's own code
     goes.

     Where the route cannot answer — under fixtures, or for a non-admin — the
     screen keeps the mockup's relay rows, so the ratified §13 sheet is what
     the fidelity gate still photographs. */
  /** @type {string | null} */
  let mailboxOutcome = $state(null);
  /** @type {string | null} */
  let mailboxProblem = $state(null);
  /** @type {string | null} */
  let mailboxBusy = $state(null);
  let editing = $state(false);
  let rotating = $state(false);
  let password = $state("");
  /** @type {{ host: string, port: number, accountUser: string, mailbox: string, tlsServerName: string, providerProfile: string, trustedRecipientHeader: string, pollSeconds: number }} */
  let draft = $state({
    host: "", port: 993, accountUser: "", mailbox: "INBOX", tlsServerName: "",
    providerProfile: "other", trustedRecipientHeader: "X-Original-To", pollSeconds: 300,
  });

  const PROVIDER_PROFILES = ["mailcow", "gmail", "outlook", "other"];
  /** @param {string} word */
  const plainly = (word) => word.replaceAll("_", " ");
  /** @param {?string} iso */
  const stamp = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "UTC" }) : "never");

  function openMailboxEditor() {
    const current = need().mailbox;
    if (current) {
      draft = {
        host: current.host, port: current.port, accountUser: current.accountUser,
        mailbox: current.mailbox, tlsServerName: current.tlsServerName,
        providerProfile: current.providerProfile,
        trustedRecipientHeader: current.trustedRecipientHeader || "X-Original-To",
        pollSeconds: current.pollSeconds,
      };
    }
    password = "";
    mailboxOutcome = null;
    mailboxProblem = null;
    editing = true;
  }

  /**
   * Runs one mailbox action and folds the answer straight back into the
   * screen, so what is shown is always the server's own account of the state
   * rather than an optimistic guess.
   *
   * @param {string} label  which button is busy
   * @param {object} command
   */
  async function mailboxAction(label, command) {
    mailboxBusy = label;
    mailboxProblem = null;
    mailboxOutcome = null;
    try {
      const answer = await commandMailbox(command);
      /* The whole screen is re-read rather than patched, the same way placing
         a person does: the machinery rows are derived from the mailbox, so a
         patch would leave them describing the previous state. */
      view = await readAdminScreen();
      mailboxOutcome = answer.outcome ?? null;
      /* Only a verified credential closes the form; a refused one leaves it
         open with what was typed, minus the password, so the administrator
         can correct a host or a port without retyping everything. */
      if (!answer.outcome || answer.outcome === "verified") {
        editing = false;
        rotating = false;
      }
      password = "";
    } catch (error) {
      mailboxProblem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    } finally {
      mailboxBusy = null;
    }
  }

  /** @type {Record<string, string>} */
  const TONE = { "--warm": "--warm", "--ok": "--ok", "--upcoming": "--upcoming", "--overdue": "--overdue" };
  /* The sheet's five hand-placed rings (design/v19/administration-iss.html,
     §Systems) turn out to be constellationPlanetsOf's own far-sky placement
     (CON-13), just re-centred on the roster's small r13 ring instead of the
     backdrop's distant one: the same orbit distance (18..30) and body size
     (2.0..2.8) divided by 6 and 4 respectively lands exactly on the sheet's
     hand-measured coordinates for all five fixture households (#775). */
  /** @param {[number, number, number, string]} planet */
  const ringDot = ([x, y, r, tone]) => ({
    cx: 17 + x / 6,
    cy: 17 + y / 6,
    r: 1 + r / 4,
    tone: TONE[tone] ?? "--ok",
  });
  /** @param {import('$lib/data/workspace.js').Household} household */
  const ringDots = (household) =>
    constellationPlanetsOf(household.items ?? [], need().today).map(ringDot);

  onMount(() => {
    let disposed = false;
    let backdropTeardown = () => {};
    /* The backdrop mounts once the screen's own data has loaded — its
       households (galaxyOf) and its caption's real facts both come from the
       same readAdminScreen() answer this screen renders from, so there is no
       second fetch. The one seed follows home's own pattern: pinned to the
       workspace under fixtures, so the fidelity gate can compare one
       deterministic sky against the mockup's; rolled fresh otherwise. */
    readAdminScreen().then((screen) => {
      if (disposed) return;
      view = screen;
      const seed = data?.fixtures ? seedFromWorkspace(screen.primary ?? "") : rollSeed();
      const galaxy = galaxyOf({ households: screen.households, activeHouseholdId: screen.primary }, screen.today);
      const domain = screen.relay.find(([label]) => label === "collection domain")?.[1] ?? "";
      backdropTeardown = mountStation(/** @type {HTMLDivElement} */ (backdropRoot), {
        seed, galaxy, primary: screen.primary,
        facts: { domain, systems: screen.households.length, crew: screen.users.length },
      });
    });
    return () => {
      disposed = true;
      backdropTeardown();
    };
  });
</script>

<svelte:head><title>Orbit — administration</title></svelte:head>

<div class="mission-page">
<div class="station-backdrop" bind:this={backdropRoot} aria-hidden="true"></div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view?.user} current="administration"
        role={view ? `${view.household?.name ?? ""} · ${view.household?.canManage ? "owner" : "member"}` : ""} />

<div class="page" role="main">
  <header class="screen">
    <h1>Administration</h1>
    <div class="sub">{view
      ? `the instance from above · admins see everything by design · ${view.users.length} people · ${view.households.length} systems`
      : "the instance from above · admins see everything by design"}</div>
  </header>

  {#if view}
    <div class="grid">

      <div class="card">
        <div class="cardhead"><h2>People</h2><button>invite someone</button></div>
        {#each view.users as person (person.id)}
          <div class="person">
            <span class="avatar">{initialsOf(person.displayName)}</span>
            <div class="who">
              <b>{person.displayName}{person.id === view.user?.id ? " · you" : ""}</b>
              <span>{[person.email, view.peopleMeta[person.id]].filter(Boolean).join(" · ")}</span>
            </div>
            <span class="role" class:admin={person.isInstanceAdmin}>{person.isInstanceAdmin ? "admin" : "user"}</span>
            {#if person.id !== view.user?.id}
              <button class="place" title="Admins can add any user to any system"
                      onclick={() => (placing = placing === person.id ? null : person.id)}>place in a system…</button>
            {/if}
          </div>
          {#if placing === person.id}
            <div class="placerow">
              {#each view.households as household (household.id)}
                <button disabled={busy === person.id} onclick={() => place(person.id, household.id)}>{household.name}</button>
              {/each}
            </div>
          {/if}
        {/each}
        {#if problem}<div class="adminproblem">{problem}</div>{/if}
      </div>

      <div class="card">
        <div class="cardhead"><h2>Systems</h2><button>new system</button></div>
        {#each view.households as household (household.id)}
          <div class="system">
            <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              <circle cx="17" cy="17" r="13" fill="none" style="stroke:var(--chart-line)"/>
              <circle cx="17" cy="17" r="2.6" style="fill:var({household.id === view.primary ? "--sun" : "--ink-mid"})"/>
              {#each ringDots(household) as dot (dot.cx + "-" + dot.cy)}
                <circle cx={dot.cx} cy={dot.cy} r={dot.r} style="fill:var({dot.tone})" opacity=".8"/>
              {/each}
            </svg>
            <div class="who">
              <b>{household.name}</b>
              <span>{[
                `${household.memberCount} member${household.memberCount === 1 ? "" : "s"}`,
                view.owners[household.id] ? `owner ${view.owners[household.id]}` : null,
                `${(household.items ?? []).length} item${(household.items ?? []).length === 1 ? "" : "s"}`,
              ].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        {/each}
      </div>

      <!-- §15: mail machinery sits WITH operations — one panel, two halves. -->
      <div class="card wide machinery">
        <div class="half">
          <div class="cardhead">
            <h2>Mail machinery</h2>
            {#if view.mailbox && !editing}
              <button onclick={openMailboxEditor}>{view.mailbox.configured ? "change mailbox…" : "set up mailbox…"}</button>
            {/if}
          </div>
          {#each view.relay as [label, value, extra] (label)}
            <div class="kv"><span>{label}</span>
              {#if extra === "on"}<b class="on">{value}</b>
              {:else if extra}<span><b>{value.split(" · ")[0]}</b> · {value.split(" · ")[1]}</span><button>{extra}</button>
              {:else}<b>{value}</b>{/if}
            </div>
          {/each}

          {#if view.mailbox}
            {@const mailbox = view.mailbox}
            <div class="kv"><span>verification</span><b>{plainly(mailbox.verificationState)} · {stamp(mailbox.verifiedAt)}</b></div>
            {#if mailbox.configured}
              <div class="kv"><span>credential set</span>
                <b>{stamp(mailbox.credentialSetAt)}{mailbox.credentialSetBy ? ` · ${mailbox.credentialSetBy}` : ""}</b></div>
              <!-- The pattern, never a member's address: the database holds
                   alias digests only, and an administrator is not a reader of
                   anyone's relay (ADR-0017 decision 5). -->
              <div class="kv"><span>address shape</span><b>{mailbox.aliasPattern ?? "—"}</b></div>
              <div class="kv"><span>envelope header</span><b>{mailbox.trustedRecipientHeader || "not set"}</b></div>
              <div class="kv"><span>provider profile</span><b>{mailbox.providerProfile}</b></div>
              <div class="kv"><span>tls name</span><b>{mailbox.tlsServerName || mailbox.host}</b></div>
            {/if}

            {#if mailbox.configured && !editing && !rotating}
              <div class="placerow mailboxrow">
                <button disabled={mailboxBusy !== null}
                        onclick={() => mailboxAction("verify", { action: "verify" })}>check connection</button>
                <button disabled={mailboxBusy !== null}
                        onclick={() => mailboxAction("probe", { action: "probe" })}>run setup probe</button>
                <button disabled={mailboxBusy !== null}
                        onclick={() => mailboxAction("enabled", {
                          action: mailbox.enabled ? "disable" : "enable",
                          expectedVersion: mailbox.version,
                        })}>{mailbox.enabled ? "pause ingest" : "resume ingest"}</button>
                <button disabled={mailboxBusy !== null} onclick={() => { rotating = true; password = ""; }}>
                  rotate password…</button>
                <button disabled={mailboxBusy !== null}
                        onclick={() => mailboxAction("remove", { action: "remove", expectedVersion: mailbox.version })}>
                  remove credential</button>
              </div>
            {/if}

            {#if rotating}
              <!-- The new password is proven against the provider before it
                   is committed; a refusal leaves the old one active. -->
              <form class="mailboxform" onsubmit={(event) => {
                event.preventDefault();
                mailboxAction("rotate", { action: "rotate", expectedVersion: mailbox.version, password });
              }}>
                <label>new password
                  <input type="password" autocomplete="new-password" bind:value={password} required /></label>
                <div class="placerow mailboxrow">
                  <button type="submit" disabled={mailboxBusy !== null}>verify and rotate</button>
                  <button type="button" onclick={() => { rotating = false; password = ""; }}>cancel</button>
                </div>
              </form>
            {/if}

            {#if editing}
              <form class="mailboxform" onsubmit={(event) => {
                event.preventDefault();
                mailboxAction("set", { action: "set", expectedVersion: mailbox.version, ...draft, password });
              }}>
                <label>host <input bind:value={draft.host} required /></label>
                <label>port <input type="number" min="1" max="65535" bind:value={draft.port} required /></label>
                <label>account <input bind:value={draft.accountUser} placeholder="intake@example.com" required /></label>
                <label>folder <input bind:value={draft.mailbox} required /></label>
                <label>tls name <input bind:value={draft.tlsServerName} placeholder="same as host" /></label>
                <label>provider
                  <select bind:value={draft.providerProfile}>
                    {#each PROVIDER_PROFILES as profile (profile)}<option value={profile}>{profile}</option>{/each}
                  </select></label>
                <label>envelope header <input bind:value={draft.trustedRecipientHeader} required /></label>
                <label>poll seconds
                  <input type="number" min="30" max="3600" bind:value={draft.pollSeconds} required /></label>
                <label>password
                  <input type="password" autocomplete="new-password" bind:value={password} required /></label>
                <p class="mailboxnote">Relay addresses are plus-addresses of this account, so it has to be one the
                  provider delivers sub-addressed mail to. The password is stored encrypted and never shown again.</p>
                <div class="placerow mailboxrow">
                  <button type="submit" disabled={mailboxBusy !== null}>verify and save</button>
                  <button type="button" onclick={() => { editing = false; password = ""; }}>cancel</button>
                </div>
              </form>
            {/if}

            {#if mailboxOutcome}<div class="adminproblem" class:ok={mailboxOutcome === "verified" || mailboxOutcome === "delivered"}>{plainly(mailboxOutcome)}</div>{/if}
            {#if mailboxProblem}<div class="adminproblem">{mailboxProblem}</div>{/if}
          {/if}
        </div>

        <div class="half">
          <div class="cardhead"><h2>Operations</h2><a href={resolve("/admin")}>open operations →</a></div>
          {#each view.services as [tone, name, detail] (name)}
            <div class="svc"><i style="background:var(--{tone})"></i><b>{name}</b><small>{detail}</small></div>
          {/each}
        </div>
      </div>

    </div>

    <div class="strip">{view.instance}</div>
  {/if}
</div>
</div>
