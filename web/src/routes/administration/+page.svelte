<script>
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import {
    addMember,
    commandContact,
    commandMailbox,
    createLocalUser,
    readAdminScreen,
    readSignInMethods,
    sendSetupLink,
    startStepUp,
  } from "$lib/data/workspace.js";
  import { SETUP_LINK_FIXTURES } from "$lib/data/fixtures/admin.js";
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
  /* ADD A LOCAL USER, AND SEND A NEW SETUP LINK (#915, ADR-0023 §3, §5;
     composition ruled in docs/plans/m7-local-accounts.md §2.7).

     There is no self-registration in Orbit: an administrator names the person,
     and Orbit MAILS them a link to choose their own password. Three things
     follow from the owner's 2026-09-09 ruling, and the markup below keeps all
     three.

       · THE LINK IS NEVER SHOWN. Not to the administrator, not to this list,
         not in a copy control — it goes to the address the account is
         registered with and nowhere else. What this screen reports is where it
         went and when it lapses.
       · A FAILED SEND IS NOT A LOST PERSON. The account is created first, so a
         mailer that refused leaves an account and a Retry rather than an error
         that threw the typing away. The reason is one bounded word.
       · THE ADMINISTRATOR IS RE-CHALLENGED EVERY TIME (ADR-0023 §5), inline,
         exactly as the helm's sign-in-methods block challenges a reader:
         somebody with a password answers with it here; somebody with only a
         provider identity is sent back to that provider first and returns with
         the proof in a cookie. `?stepup=` names what they left to do. */
  const SETUP_LINK_DAYS = { min: 1, max: 14, fallback: 7 };
  let localDraft = $state({ email: "", displayName: "", expiresInDays: SETUP_LINK_DAYS.fallback });
  /** True once Create has been tapped and the challenge under it is open. */
  let localArmed = $state(false);
  let localPassword = $state("");
  let localBusy = $state(false);
  /** @type {?(Awaited<ReturnType<typeof sendSetupLink>> & { userId?: string })} */
  let localDelivery = $state(null);
  /** @type {string | null} */
  let localProblem = $state(null);
  /**
   * Whether the acting administrator has a password of their own. It decides
   * which challenge every action on this screen asks for, so it is read once
   * with the screen rather than guessed per button. It starts true because
   * that is the answer for almost every administrator and the one the server
   * re-checks anyway — a wrong guess costs a refused request, never a change
   * that should not have happened.
   */
  let actorHasPassword = $state(true);
  /**
   * Which action this page load already carries a step-up proof for, if any.
   * The intent and not a boolean, because a proof is bound to ONE action
   * (ADR-0023 §5): one earned for creating a user cannot be spent issuing
   * somebody a link, and the server would refuse it if this screen tried.
   * Without it an OIDC-only administrator would be sent back to the provider
   * by the very tap that was supposed to spend the proof they just earned.
   * @type {string}
   */
  let provenIntent = $state("");

  /**
   * The typed draft, carried across a step-up (#915). Leaving for the provider
   * is a full navigation, so without this an OIDC-only administrator would
   * come back to an empty form and have to type the person in again. Session
   * storage, not local: it belongs to this tab and this errand, and it holds
   * only what the administrator typed — never a password, never a link.
   */
  const DRAFT_KEY = "orbit-local-user-draft";

  function stashDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(localDraft)); } catch { /* storage refused: the form simply starts empty */ }
  }

  function restoreDraft() {
    try {
      const held = sessionStorage.getItem(DRAFT_KEY);
      sessionStorage.removeItem(DRAFT_KEY);
      if (held) localDraft = { ...localDraft, ...JSON.parse(held) };
    } catch { /* nothing held, or unreadable: the form starts empty */ }
  }

  /** Which person's "send a new setup link" is open, by user id. @type {string | null} */
  let resendFor = $state(null);
  let resendDays = $state(SETUP_LINK_DAYS.fallback);
  let resendPassword = $state("");
  let resendBusy = $state(false);
  /** @type {Awaited<ReturnType<typeof sendSetupLink>> | null} */
  let resendDelivery = $state(null);
  /** @type {string | null} */
  let resendProblem = $state(null);

  /** The lapse date as a reader reads it, in UTC so the gate photographs one date. */
  /** @param {string} iso */
  const lapses = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

  /** The mailer's bounded word, said plainly. @param {string} reason */
  const sendWords = (reason) =>
    reason === "smtp_unconfigured"
      ? "this instance has no outgoing mail configured, so nothing was sent"
      : reason === "smtp_unavailable"
        ? "the mail server could not be reached, so nothing was sent"
        : reason === "smtp_rejected"
          ? "the mail server refused the message, so nothing was sent"
          : "the message could not be sent";

  /** What a refused action means here, from the bounded code. @param {unknown} error */
  function setupWords(error) {
    const code = /** @type {{ code?: string, message?: string }} */ (error)?.code;
    if (code === "recent_authentication_required") return "that isn't your current password — nothing was created";
    if (code === "too_many_attempts") return "too many attempts at once; try again shortly";
    if (code === "provider_handover_unreadable") {
      return "not started — Orbit could not hand you to your identity provider";
    }
    return /** @type {{ message?: string }} */ (error)?.message ?? String(error);
  }

  /**
   * The first tap on a challenged action. An administrator with a password
   * gets the field under it; one without is handed to the provider and comes
   * back here with the proof.
   *
   * @param {string} intent
   * @param {() => void} openField
   */
  async function challengeThen(intent, openField) {
    localProblem = null;
    resendProblem = null;
    if (actorHasPassword || provenIntent === intent) { openField(); return; }
    try {
      stashDraft();
      await startStepUp({ intent, returnTo: `/administration?stepup=${encodeURIComponent(intent)}` });
    } catch (error) {
      localProblem = setupWords(error);
    }
  }

  /** Creates the account and mails its link (ADR-0023 §3). */
  async function createLocalUserNow() {
    if (localBusy) return;
    localBusy = true;
    localProblem = null;
    localDelivery = null;
    try {
      const answer = await createLocalUser({
        email: localDraft.email,
        displayName: localDraft.displayName,
        expiresInDays: Number(localDraft.expiresInDays),
        ...(actorHasPassword ? { currentPassword: localPassword } : {}),
      });
      localDelivery = { ...answer, userId: answer.user?.id };
      localArmed = false;
      localPassword = "";
      provenIntent = "";
      /* Only a send that got out clears the form: a failure keeps what was
         typed so the administrator can read it back against the Retry. */
      if (!answer.sendError) {
        localDraft = { email: "", displayName: "", expiresInDays: SETUP_LINK_DAYS.fallback };
      }
      view = await readAdminScreen();
    } catch (error) {
      localProblem = setupWords(error);
    } finally {
      localBusy = false;
    }
  }

  /**
   * Sends a fresh link — the Retry under a failed send, and the per-row
   * control. Issuing one kills the earlier link, so this is the same act
   * either way.
   *
   * @param {string} userId
   * @param {number} days
   * @param {string} password
   */
  async function sendSetupLinkNow(userId, days, password) {
    if (resendBusy || localBusy) return;
    resendBusy = true;
    localBusy = true;
    resendProblem = null;
    try {
      const answer = await sendSetupLink(userId, {
        expiresInDays: Number(days),
        ...(actorHasPassword ? { currentPassword: password } : {}),
      });
      resendDelivery = answer;
      if (localDelivery?.userId === userId) localDelivery = { ...answer, userId };
      resendFor = null;
      resendPassword = "";
      provenIntent = "";
    } catch (error) {
      resendProblem = setupWords(error);
    } finally {
      resendBusy = false;
      localBusy = false;
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

  /**
   * How long the rotation card's subject has been open (#956), in the
   * sentence register — "open 3 days" — where format.js's ago() speaks in
   * chrome shorthand and appends "ago".
   * @param {string} iso
   */
  const openFor = (iso) => {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  };

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

  /* The public contact address (#860): one field an administrator sets,
     changes or clears, never defaulted from any account's own email. Named
     plainly on the door's third state (#788) when it cannot open safely — so
     unlike the mailbox above, there is no "verify" step: it is a published
     string, not a credential, and Orbit never talks to it. */
  let editingContact = $state(false);
  let contactDraft = $state("");
  /** @type {string | null} */
  let contactProblem = $state(null);
  let contactBusy = $state(false);

  function openContactEditor() {
    contactDraft = need().contact?.address ?? "";
    contactProblem = null;
    editingContact = true;
  }

  /** @param {{ action: "set", address: string } | { action: "clear" }} partial */
  async function contactAction(partial) {
    const current = need().contact;
    if (!current) return;
    contactBusy = true;
    contactProblem = null;
    try {
      await commandContact({ ...partial, expectedVersion: current.version });
      view = await readAdminScreen();
      editingContact = false;
    } catch (error) {
      contactProblem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    } finally {
      contactBusy = false;
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
    /* #915: which challenge this administrator answers with, and — under
       fixtures, where no challenged route can be reached at all — the delivery
       answer the "add a local user" row is drawn from. `?localuser=` names
       which of the two outcomes, so both can be photographed and walked. */
    const parameters = new URLSearchParams(window.location.search);
    if (data?.fixtures) {
      const wanted = parameters.get("localuser");
      if (wanted) {
        localDelivery = /** @type {any} */ (SETUP_LINK_FIXTURES)[wanted] ?? SETUP_LINK_FIXTURES.sent;
      }
    } else {
      readSignInMethods()
        .then((own) => { if (!disposed) actorHasPassword = own.local.set; })
        .catch(() => { /* additive: the password field stays the assumption */ });
      /* Back from the provider carrying a proof: pick the errand up where it
         was left rather than making them type the person in again. */
      const resumed = parameters.get("stepup");
      if (resumed) {
        restoreDraft();
        actorHasPassword = false;
        provenIntent = resumed;
      }
    }

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

      <!-- AN OPEN DOCUMENT-KEY ROTATION (#956). The composition call, made
           deliberately: this renders NOTHING when no rotation is open — the
           common case earns zero pixels (and the fixture-mode screen the
           fidelity gate photographs is unchanged) — and when one IS open it
           stands first in the grid, full width, because the state's whole
           failure mode is being forgotten. It is a notice, not an alarm: a
           rotation is a deliberate operator procedure mid-flight, so it
           speaks in the card's ordinary voice with an accent edge, states
           the fact, how long, and the next step, and offers no buttons —
           finishing a rotation is a shell procedure, not a click. It is
           self-contained by design so #941's damaged/locked counts can stand
           beside it later without either being rewritten. -->
      {#if view.rotation?.inProgress}
        <div class="card wide rotation">
          <div class="cardhead"><h2>Document key rotation in progress</h2>
            <span class="since">{view.rotation.startedAt
              ? `open ${openFor(view.rotation.startedAt)} · since ${stamp(view.rotation.startedAt)}`
              : "start time not recorded"}</span></div>
          <p class="rotationwords">
            {#if view.rotation.secondKeyLoaded}
              Orbit is holding two document keys while the rotation runs. Every document stays readable —
              this is safe, but it is meant to be brief. Finish the procedure: run the rewrap, promote the
              new key, remove the old one — “Rotating the document key-encryption key” in the administrator
              guide has the steps.
            {:else}
              A rotation was started and never recorded as finished, and this instance is no longer holding
              the second key. Check where the rotation got to before changing anything — see “Rotating the
              document key-encryption key” in the administrator guide.
            {/if}
          </p>
        </div>
      {/if}

      <div class="card">
        <div class="cardhead"><h2>People</h2><button>invite someone</button></div>

        <!-- ADD A LOCAL USER (#915, ADR-0023 §3; composition §2.7): the row
             above the roster. Three things and a button — who they are, and
             how long their setup link should live. Orbit mails the link to
             the address typed here; it is never shown on this screen, so
             there is deliberately nothing to copy. -->
        <form class="localuser" onsubmit={(event) => { event.preventDefault();
                                                       if (localArmed || provenIntent === "local_user_create") createLocalUserNow();
                                                       else challengeThen("local_user_create", () => (localArmed = true)); }}>
          <label for="localuser-email">email</label>
          <input id="localuser-email" type="email" autocomplete="off" placeholder="newcomer@example.com"
                 bind:value={localDraft.email} required />
          <label for="localuser-name">display name</label>
          <input id="localuser-name" autocomplete="off" placeholder="Their name"
                 bind:value={localDraft.displayName} required />
          <label for="localuser-days">link valid for</label>
          <span class="days">
            <input id="localuser-days" type="number" min={SETUP_LINK_DAYS.min} max={SETUP_LINK_DAYS.max}
                   bind:value={localDraft.expiresInDays} required /> days
          </span>
          {#if localArmed}
            <!-- The inline challenge, the same two-tap shape the helm's
                 sign-in-methods block uses: Create arms it, this confirms it. -->
            <label for="localuser-current">your current password</label>
            <input id="localuser-current" type="password" autocomplete="current-password"
                   bind:value={localPassword} required />
          {/if}
          <div class="placerow localuserrow">
            <button type="submit" disabled={localBusy}>{localArmed ? "create and send the link" : "create"}</button>
            {#if localArmed}
              <button type="button" onclick={() => { localArmed = false; localPassword = ""; }}>cancel</button>
            {/if}
          </div>
        </form>
        {#if localDelivery}
          {#if localDelivery.sendError}
            <div class="adminproblem">
              {localDelivery.sentTo} was created, but {sendWords(localDelivery.sendError)}
              <button class="retry" disabled={localBusy}
                      onclick={() => sendSetupLinkNow(
                        /** @type {string} */ (localDelivery?.userId),
                        localDraft.expiresInDays,
                        localPassword,
                      )}>retry</button>
            </div>
          {:else}
            <div class="adminproblem ok">Setup link sent to {localDelivery.sentTo}, valid until {lapses(localDelivery.expiresAt)}</div>
          {/if}
        {/if}
        {#if localProblem}<div class="adminproblem">{localProblem}</div>{/if}

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
              <!-- A fresh link for somebody who never used theirs, or who has
                   forgotten their password (ADR-0023 §3). Issuing it kills the
                   earlier one, and it goes to their registered address — this
                   screen never sees it. -->
              <button class="place" onclick={() => challengeThen("setup_link_issue", () => {
                        resendFor = resendFor === person.id ? null : person.id;
                        resendDays = SETUP_LINK_DAYS.fallback;
                        resendPassword = "";
                        resendDelivery = null;
                      })}
                      aria-expanded={resendFor === person.id}
                      aria-label={`send a new setup link to ${person.displayName}`}>send a new setup link…</button>
            {/if}
          </div>
          {#if placing === person.id}
            <div class="placerow">
              {#each view.households as household (household.id)}
                <button disabled={busy === person.id} onclick={() => place(person.id, household.id)}>{household.name}</button>
              {/each}
            </div>
          {/if}
          {#if resendFor === person.id}
            <form class="localuser resend" onsubmit={(event) => { event.preventDefault();
                                                                 sendSetupLinkNow(person.id, resendDays, resendPassword); }}>
              <label for="resend-days">link valid for</label>
              <span class="days">
                <input id="resend-days" type="number" min={SETUP_LINK_DAYS.min} max={SETUP_LINK_DAYS.max}
                       bind:value={resendDays} required /> days
              </span>
              {#if actorHasPassword}
                <label for="resend-current">your current password</label>
                <input id="resend-current" type="password" autocomplete="current-password"
                       bind:value={resendPassword} required />
              {/if}
              <div class="placerow localuserrow">
                <button type="submit" disabled={resendBusy}>send it</button>
                <button type="button" onclick={() => (resendFor = null)}>cancel</button>
              </div>
            </form>
          {/if}
        {/each}
        {#if resendDelivery}
          {#if resendDelivery.sendError}
            <div class="adminproblem">{sendWords(resendDelivery.sendError)}</div>
          {:else}
            <div class="adminproblem ok">Setup link sent to {resendDelivery.sentTo}, valid until {lapses(resendDelivery.expiresAt)}</div>
          {/if}
        {/if}
        {#if resendProblem}<div class="adminproblem">{resendProblem}</div>{/if}
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

      <!-- #860: one published address, never a real administrator's own
           mailbox. Read by the sign-in door's third state (#788) with no
           session at all, so this card is the only place it is ever set. -->
      <div class="card">
        <div class="cardhead"><h2>Public contact</h2>
          {#if view.contact && !editingContact}
            <button onclick={openContactEditor}>{view.contact.address ? "change…" : "set…"}</button>
          {/if}
        </div>
        <div class="kv"><span>address</span><b>{view.contact?.address ?? "not set"}</b></div>
        {#if view.contact}
          {#if editingContact}
            <form class="mailboxform" onsubmit={(event) => {
              event.preventDefault();
              contactAction({ action: "set", address: contactDraft });
            }}>
              <label>address <input type="email" bind:value={contactDraft} placeholder="ops@example.com" required /></label>
              <p class="mailboxnote">Shown on the sign-in door if it ever cannot open safely — never
                a real administrator's own mailbox. Anyone can read it, signed in or not.</p>
              <div class="placerow mailboxrow">
                <button type="submit" disabled={contactBusy}>save</button>
                {#if view.contact.address}
                  <button type="button" disabled={contactBusy} onclick={() => contactAction({ action: "clear" })}>clear</button>
                {/if}
                <button type="button" onclick={() => (editingContact = false)}>cancel</button>
              </div>
            </form>
          {/if}
          {#if contactProblem}<div class="adminproblem">{contactProblem}</div>{/if}
        {/if}
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
