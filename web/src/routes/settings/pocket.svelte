<script>
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import { wake } from "$lib/pocket/wake.js";
  import { applyTheme } from "$lib/theme-swatches.js";
  import { agoLong } from "$lib/format.js";
  import { alertsSupported, currentSubscription, disableAlerts, enableAlerts } from "$lib/push/alerts.js";
  import {
    readSentLately,
    readSignInMethods,
    removeLocalPassword,
    revokeSession,
    signOutEverywhere,
    startProviderLink,
    startStepUp,
    unlinkProviderIdentity,
    writeLocalPassword,
    writeReminders,
  } from "$lib/data/workspace.js";
  import { SENT_LATELY_FIXTURE } from "$lib/data/fixtures/settings.js";
  import { PACKS, intentOf, issuerHost, methodWords, on } from "./helm.js";

  /*
   * SETTINGS ON A PHONE (#1125, proposal §2.7-§2.8). Rendered beside the
   * desk's cards and chosen by CSS (the switch at the foot), as the
   * household's is. The desk page loads the screen and hands it over bound,
   * so both dialects hold one copy of what the server said.
   *
   * Top to bottom, in the order a person uses them:
   *   YOU: who you are, then how you sign in (password, provider, the emailed
   *     approval). Changing a method opens a callout that asks you to prove
   *     it is you first (§17), with your password or at your provider.
   *   YOUR SKY: the five packs as a strip of tiles.
   *   REMINDERS: two tabs (§20, §22) · the switches and the two warnings,
   *     each warning opening a picker · what Orbit sent you lately.
   *   YOUR RELAY: the address (tap copies), whether it listens, what waits.
   *   YOUR SYSTEMS: a row per household, each the way in.
   *   WHERE YOU'RE SIGNED IN: a row per device, tap to open · sign out
   *     (review round §1.1), then sign out of every device, which arms.
   *
   * States, one grammar (§1.13): a save shows on its control while it is
   * out, a saved change raises the wake, a failure is a red line under the
   * control that stays until the next attempt, and an act the server wants
   * proof for opens the callout.
   */

  /** @typedef {Awaited<ReturnType<typeof import('$lib/data/workspace.js').readSettingsScreen>>} SettingsView */
  /** @typedef {Awaited<ReturnType<typeof readSignInMethods>>} Methods */
  /** @typedef {Awaited<ReturnType<typeof import('$lib/data/workspace.js').readSessions>>} Sessions */
  /** @typedef {import('$lib/data/fixtures/settings.js').SentRow} SentRow */

  /**
   * @type {{
   *   view: SettingsView | null,
   *   methods: Methods | null,
   *   sessions: Sessions,
   *   active: string,
   *   initials: string,
   *   providerOffered: boolean,
   *   emailApproval: boolean,
   *   methodsProblem: string | null,
   *   sessionsProblem: string | null,
   *   resumed: string | null,
   *   fixtures: boolean,
   * }}
   */
  let {
    view = $bindable(),
    methods = $bindable(),
    sessions = $bindable(),
    active = $bindable(),
    initials,
    providerOffered,
    emailApproval,
    methodsProblem,
    sessionsProblem,
    resumed,
    fixtures,
  } = $props();

  /* ── reminders ────────────────────────────────────────────────────────── */
  let tab = $state(/** @type {"reminders" | "sent"} */ ("reminders"));
  let emailSaving = $state(false);
  let reminderProblem = $state(/** @type {string | null} */ (null));
  const emailOn = $derived(view?.reminders.emailEnabled ?? false);

  async function toggleEmail() {
    if (!view || emailSaving) return;
    const reminders = view.reminders;
    const next = !reminders.emailEnabled;
    /* Optimistic, as the desk's: a switch that waits for a round trip reads
       as dead. The revert in the catch is what keeps it honest. */
    view = { ...view, reminders: { ...reminders, emailEnabled: next } };
    emailSaving = true;
    reminderProblem = null;
    try {
      const saved = await writeReminders({
        emailEnabled: next,
        firstWarningDays: reminders.firstWarningDays,
        finalWarningDays: reminders.finalWarningDays,
      });
      if (view) view = { ...view, reminders: saved };
      wake(`saved · email reminders ${saved.emailEnabled ? "on" : "off"}`);
    } catch {
      if (view) view = { ...view, reminders };
      reminderProblem = "not saved — Orbit could not reach your reminder settings";
    } finally {
      emailSaving = false;
    }
  }

  /* Browser alerts belong to this browser alone (#763), so the row says
     "this device" and reads its state here, never from the account. */
  let alertsAvailable = $state(true);
  let browserAlerts = $state(false);
  let alertsBusy = $state(false);
  let alertsProblem = $state(/** @type {string | null} */ (null));

  async function toggleAlerts() {
    if (alertsBusy || !alertsAvailable) return;
    /* Not optimistic: switching on opens the browser's own prompt, and the
       switch must not claim to be on while that is still being answered. */
    alertsBusy = true;
    alertsProblem = null;
    try {
      if (browserAlerts) { await disableAlerts(); browserAlerts = false; }
      else { await enableAlerts(); browserAlerts = true; }
      wake(`saved · browser alerts ${browserAlerts ? "on" : "off"} on this device`);
    } catch (error) {
      browserAlerts = Boolean(await currentSubscription());
      const reason = /** @type {{ code?: string }} */ (error)?.code;
      alertsProblem = reason === "permission_denied"
        ? "your browser is refusing alerts. allow notifications for Orbit, then try again"
        : reason === "unconfigured"
          ? "not switched on — this Orbit has no push keys yet, which is your administrator’s to set"
          : "not switched on — Orbit could not reach your alert settings";
    } finally {
      alertsBusy = false;
    }
  }

  /* The two warnings (#468). The route has always taken the pair; the
     phone draws the picker the proposal gives it (§2.7 step 4). The server
     holds the rule (1-365 days, the final closer than the first), so the
     picker offers only choices it will accept. */
  const FIRST_CHOICES = [60, 30, 21, 14, 7];
  const FINAL_CHOICES = [7, 3, 1, 0];
  let picking = $state(/** @type {"first" | "final" | null} */ (null));
  let pickerOpen = $state(false);
  let timingSaving = $state(/** @type {"first" | "final" | null} */ (null));

  /** @param {number} days */
  const daysWord = (days) => (days === 0 ? "on the day" : `${days} day${days === 1 ? "" : "s"}`);
  /** @param {number} days */
  const beforeWord = (days) => (days === 0 ? "on the day" : `${daysWord(days)} before`);

  const choices = $derived.by(() => {
    if (!view || !picking) return [];
    /* Unset offsets read as the server's own defaults (14 and 3). */
    const first = view.reminders.firstWarningDays ?? 14;
    const final = view.reminders.finalWarningDays ?? 3;
    const pool = picking === "first" ? [...FIRST_CHOICES, first] : [...FINAL_CHOICES, final];
    const allowed = pool.filter((days) => (picking === "first" ? days > final : days < first));
    return [...new Set(allowed)].sort((a, b) => b - a);
  });

  /** @param {"first" | "final"} which */
  function openPicker(which) {
    picking = which;
    pickerOpen = true;
  }

  /** @param {number} days */
  async function pick(days) {
    if (!view || !picking) return;
    const which = picking;
    pickerOpen = false;
    const reminders = view.reminders;
    const current = which === "first" ? reminders.firstWarningDays : reminders.finalWarningDays;
    if (days === current) return;
    timingSaving = which;
    reminderProblem = null;
    try {
      const saved = await writeReminders({
        emailEnabled: reminders.emailEnabled,
        firstWarningDays: which === "first" ? days : reminders.firstWarningDays,
        finalWarningDays: which === "final" ? days : reminders.finalWarningDays,
      });
      if (view) view = { ...view, reminders: saved };
      wake(`saved · ${which} warning ${beforeWord(days)}`);
    } catch {
      reminderProblem = `not saved — the ${which} warning is still ${beforeWord(current ?? 0)}`;
    } finally {
      timingSaving = null;
    }
  }

  /* SENT TO YOU LATELY (#1003, §20, proposal §2.8). `GET /api/settings/sent`
     read in onMount below; `null` is the "couldn't load" state the panel
     already draws, not a loading placeholder. Under fixtures it is the shape
     #1003 names instead, so the gate never needs a database behind it;
     `?sent=none|off` picks the gate's other two states. */
  let sent = $state(/** @type {SentRow[] | null} */ (null));
  let scene = $state("some");

  /** @param {string} iso */
  function when(iso) {
    const date = new Date(iso);
    const zone = fixtures ? "UTC" : undefined;
    const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: zone });
    const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone });
    return `${day} ${time}`;
  }
  /** @param {SentRow} row */
  const sentMeta = (row) =>
    /* Round 3 §8: `alert · 14 days` beside the date; `before` is the reminders
       tab's own grammar, and `browser alert` took the value's room. */
    `${row.channel === "email" ? "email" : "alert"} · ${daysWord(row.daysBefore)}`;

  const bothOff = $derived(view !== null && !emailOn && !browserAlerts);

  /* §22's keyboard: one tab in the Tab order, ← → between them. */
  /** @param {KeyboardEvent} event */
  function tabKey(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    tab = tab === "reminders" ? "sent" : "reminders";
    queueMicrotask(() => document.getElementById(`st-tab-${tab}`)?.focus());
  }

  /* ── your sky ─────────────────────────────────────────────────────────── */
  /** @param {string} id */
  function pickPack(id) {
    active = id;
    applyTheme(id);
  }

  /* ── your relay: the address copies ───────────────────────────────────── */
  async function copyAddress() {
    const address = view?.relay.address;
    if (!address || address === "no address yet") return;
    try {
      await navigator.clipboard.writeText(address);
      wake("copied · your relay address");
    } catch {
      wake("not copied — your browser kept the clipboard closed", { failure: true });
    }
  }

  /* ── sign-in methods and the recent-authentication callout (§17) ─────── */
  const hasPassword = $derived(methods?.local.set ?? false);
  const identities = $derived(methods?.oidc ?? []);
  let action = $state(/** @type {string | null} */ (null));
  let methodOpen = $state(false);
  let currentPassword = $state("");
  let newPassword = $state("");
  let methodBusy = $state(false);
  let methodProblem = $state(/** @type {string | null} */ (null));
  /** Whether this visit is standing on a step-up proof for `action`. */
  let proven = $state(false);

  const methodTitle = $derived.by(() => {
    if (!action) return "";
    if (action === "password_set") return "Set a password";
    if (action === "password_change") return "Change your password";
    if (action === "password_remove") return "Remove your password?";
    if (action === "link_oidc") return "Link your identity provider";
    const identity = identities.find((one) => `unlink:${one.id}` === action);
    return `Unlink ${identity ? issuerHost(identity.issuer) : "this provider"}?`;
  });
  const wantsNew = $derived(action === "password_set" || action === "password_change");
  const confirmLabel = $derived(
    action === "password_remove" ? "remove it"
      : action === "link_oidc" ? "continue to your provider →"
        : action?.startsWith("unlink:") ? "unlink it" : "save it",
  );

  /** @param {string} next */
  function openMethod(next) {
    action = next;
    currentPassword = "";
    newPassword = "";
    methodProblem = null;
    proven = false;
    methodOpen = true;
  }

  /* Back from the provider with a proof for the action they left to do
     (ADR-0023 §5): the callout opens again, ready to finish it. */
  let reopened = false;
  $effect(() => {
    if (!resumed || reopened || !methods) return;
    reopened = true;
    openMethod(resumed);
    proven = true;
  });

  async function toProvider() {
    if (!action) return;
    methodProblem = null;
    const identity = action.startsWith("unlink:") ? `&identity=${encodeURIComponent(action.slice(7))}` : "";
    try {
      await startStepUp({ intent: intentOf(action), returnTo: `/settings?stepup=${encodeURIComponent(action)}${identity}` });
    } catch (error) {
      methodProblem = methodWords(error);
    }
  }

  async function confirmMethod() {
    if (!action || methodBusy) return;
    methodBusy = true;
    methodProblem = null;
    /* A step-up proof travels as a cookie, a password in the body: exactly
       one of them is in play. */
    const challenge = hasPassword ? { currentPassword } : {};
    try {
      /** @type {string} */
      let outcome = "";
      if (action === "link_oidc") {
        await startProviderLink({ returnTo: "/settings", ...challenge });
        return;
      }
      if (action === "password_set" || action === "password_change") {
        const result = await writeLocalPassword({ password: newPassword, ...challenge });
        outcome = result.changed ? "password changed · every other device was signed out" : "password set";
      } else if (action === "password_remove") {
        await removeLocalPassword(challenge);
        outcome = "password removed";
      } else if (action.startsWith("unlink:")) {
        await unlinkProviderIdentity(action.slice(7), challenge);
        outcome = "identity provider unlinked";
      }
      methodOpen = false;
      wake(outcome);
      methods = await readSignInMethods();
    } catch (error) {
      methodProblem = methodWords(error);
    } finally {
      methodBusy = false;
    }
  }

  /* ── where you're signed in ───────────────────────────────────────────── */
  let sessionProblem = $state(/** @type {string | null} */ (null));
  let everywhereProblem = $state(/** @type {string | null} */ (null));
  const now = new Date().toISOString();

  /** @param {Sessions[number]} row */
  async function signOutOf(row) {
    sessionProblem = null;
    try {
      await revokeSession(row.id);
      /* Ending this device's own session leaves nothing to come back to. */
      if (row.current) { location.assign("/login"); return; }
      sessions = sessions.filter((one) => one.id !== row.id);
      wake(`signed out of ${row.device}`);
    } catch {
      sessionProblem = `still signed in on ${row.device} — try again`;
    }
  }

  async function signOutEverywhereNow() {
    everywhereProblem = null;
    try {
      await signOutEverywhere();
      location.assign("/login");
    } catch {
      everywhereProblem = "still signed in — try again";
    }
  }

  /** @param {string} device */
  const onPhone = (device) => /iphone|android|ipad|phone/i.test(device);

  /* round-3 §3.7: the pocket's linked-provider meta drops the year -- the
     desk keeps `helm.js`'s `on()` in full. */
  /** @param {string} iso */
  const onNoYear = (iso) => on(iso).replace(/ \d{4}$/, "");

  onMount(async () => {
    const parameters = new URLSearchParams(location.search);
    if (fixtures) {
      scene = parameters.get("sent") ?? "some";
      sent = scene === "none" ? [] : SENT_LATELY_FIXTURE;
      if (parameters.get("tab") === "sent") tab = "sent";
    } else {
      try {
        sent = await readSentLately();
      } catch {
        sent = null;
      }
    }
    alertsAvailable = alertsSupported();
    if (alertsAvailable) browserAlerts = Boolean(await currentSubscription());
  });
  /* The gate's both-off scene: email reminders off in the loaded view. */
  $effect(() => {
    if (scene === "off" && view?.reminders.emailEnabled) {
      view = { ...view, reminders: { ...view.reminders, emailEnabled: false } };
    }
  });
</script>

<div class="st-pocket">
  <Sky />
  <main class="st-column">
    <header class="st-head p-land" style:--i="0">
      <h1 class="p-title">Settings</h1>
      <p class="st-levers p-prose">your controls, and only yours</p>
    </header>

    <!-- YOU, with how you sign in folded in (§2.7 step 2). -->
    <section class="p-card" style:--i="1" aria-labelledby="st-you">
      <h2 class="p-caps" id="st-you">You</h2>
      {#if view}
        <div class="st-id">
          <span class="st-avatar" aria-hidden="true"><span>{initials}</span></span>
          <div class="st-who">
            <b>{view.user?.displayName ?? ""}</b>
            <span>{view.user?.email ?? ""}</span>
          </div>
        </div>
        <h3 class="st-sub p-caps" id="st-methods">Sign-in methods</h3>
        <div class="st-rows" data-row-group>
          {#if methods}
            {#if hasPassword}
              <Row title="password" meta={`set${methods.local.changedAt ? ` · changed ${on(methods.local.changedAt)}` : ""}`}
                   acts={[
                     { label: "change", name: "Change your password", tone: "accent", onact: () => openMethod("password_change") },
                     { label: "remove", name: "Remove your password", danger: true, onact: () => openMethod("password_remove") },
                   ]}>
                {#snippet mark()}<span class="st-glyph">✱</span>{/snippet}
              </Row>
            {:else}
              <Row title="password" meta="not set">
                {#snippet mark()}<span class="st-glyph off">✱</span>{/snippet}
                {#snippet below()}<button class="p-pill act-accent" onclick={() => openMethod("password_set")}>set a password</button>{/snippet}
              </Row>
            {/if}
            {#each identities as identity (identity.id)}
              <Row title={issuerHost(identity.issuer)} meta={`provider · linked ${onNoYear(identity.linkedAt)}`}
                   acts={[{ label: "unlink", name: `Unlink ${issuerHost(identity.issuer)}`, danger: true,
                            onact: () => openMethod(`unlink:${identity.id}`) }]}>
                {#snippet mark()}<span class="st-glyph">⌘</span>{/snippet}
              </Row>
            {/each}
            {#if providerOffered && identities.length === 0}
              <Row title="identity provider" meta="not linked">
                {#snippet mark()}<span class="st-glyph off">⌘</span>{/snippet}
                {#snippet below()}<button class="p-pill act-accent" onclick={() => openMethod("link_oidc")}>link your provider →</button>{/snippet}
              </Row>
            {/if}
            <!-- #1033: nobody chooses the second factor, so this row carries a
                 value, not a switch. The instance's relay decides it. -->
            <Row title="email approval" metaFace="ui"
                 meta={emailApproval ? "every password sign-in" : "no mail relay set up"}
                 trail={emailApproval ? "on" : "off"} trailTone={emailApproval ? "var(--ok-text)" : ""}>
              {#snippet mark()}<span class="st-glyph">✉</span>{/snippet}
            </Row>
          {:else if !methodsProblem}
            <div class="p-unlit"></div><div class="p-unlit"></div>
          {/if}
        </div>
        {#if methodsProblem}<p class="p-error" role="alert">{methodsProblem}</p>{/if}
      {:else}
        <div class="p-unlit"></div><div class="p-unlit"></div><div class="p-unlit"></div>
      {/if}
    </section>

    <!-- YOUR SKY: five tiles, the chosen one ringed (§2.7 step 3). -->
    <section class="p-card" style:--i="2" aria-labelledby="st-sky">
      <h2 class="p-caps" id="st-sky">Your sky</h2>
      <div class="st-packs" role="group" aria-labelledby="st-sky">
        {#each PACKS as [name, title, line, ground, [sun, warm, ok, upcoming]] (name)}
          <button class="st-pack" aria-pressed={active === name} aria-label="{title} — {line}" onclick={() => pickPack(name)}>
            <span class="st-swatch" style:background={ground} aria-hidden="true">
              <i class="st-sun" style:background={sun}></i>
              <i style="left:58px;top:30px;width:7px;height:7px;background:{warm}"></i>
              <i style="left:78px;top:14px;width:5px;height:5px;background:{ok}"></i>
              <i style="left:92px;top:38px;width:4px;height:4px;background:{upcoming}"></i>
            </span>
            <span class="st-packname" aria-hidden="true">{title}</span>
          </button>
        {/each}
      </div>
    </section>

    <!-- REMINDERS, two tabs (§20, §22 under 560px). -->
    <section class="p-card" style:--i="3" aria-labelledby="st-reminders" data-st="reminders">
      <div class="st-cardhead">
        <h2 class="p-caps" id="st-reminders">Reminders</h2>
        <div class="st-tabs" role="tablist" aria-labelledby="st-reminders">
          <button role="tab" id="st-tab-reminders" aria-selected={tab === "reminders"} aria-controls="st-panel-reminders"
                  tabindex={tab === "reminders" ? 0 : -1} onclick={() => (tab = "reminders")} onkeydown={tabKey}>reminders</button>
          <button role="tab" id="st-tab-sent" aria-selected={tab === "sent"} aria-controls="st-panel-sent"
                  tabindex={tab === "sent" ? 0 : -1} onclick={() => (tab = "sent")} onkeydown={tabKey}>sent to you lately</button>
        </div>
      </div>

      <div role="tabpanel" id="st-panel-reminders" aria-labelledby="st-tab-reminders" hidden={tab !== "reminders"}>
        {#if view}
          <div class="st-rows">
            <Row title="email reminders" meta={emailSaving ? "saving…" : emailOn ? "on · to " + (view.user?.email ?? "you") : "off"}>
              {#snippet mark()}<span class="st-glyph" class:off={!emailOn}>✉</span>{/snippet}
              {#snippet end()}
                <button class="st-switch" role="switch" aria-checked={emailOn} aria-busy={emailSaving}
                        aria-label="Email reminders" onclick={toggleEmail}><i></i></button>
              {/snippet}
            </Row>
            <Row title="browser alerts · this device" metaFace="ui"
                 meta={!alertsAvailable ? "not available in this browser" : alertsBusy ? "waiting for your browser…" : browserAlerts ? "on" : "off"}>
              {#snippet mark()}<span class="st-glyph" class:off={!browserAlerts}><svg class="st-icon" width="16" height="17" viewBox="0 0 16 17" aria-hidden="true"><path d="M3 12V7.5a5 5 0 0 1 10 0V12l1.5 1.8h-13z"/><path d="M6.3 15.6a1.8 1.8 0 0 0 3.4 0"/></svg></span>{/snippet}
              {#snippet end()}
                <button class="st-switch" role="switch" aria-checked={browserAlerts} aria-busy={alertsBusy}
                        aria-label="Browser alerts on this device" disabled={!alertsAvailable} onclick={toggleAlerts}><i></i></button>
              {/snippet}
            </Row>
            <Row title="first warning" meta="before it’s due"
                 trail={timingSaving === "first" ? "saving…" : daysWord(view.reminders.firstWarningDays ?? 0)}
                 trailTone="var(--accent-text)" onactivate={() => openPicker("first")}>
              {#snippet mark()}<span class="p-body soon"></span>{/snippet}
            </Row>
            <Row title="final warning" meta={view.reminders.finalWarningDays === 0 ? "the day itself" : "before it’s due"}
                 trail={timingSaving === "final" ? "saving…" : daysWord(view.reminders.finalWarningDays ?? 0)}
                 trailTone="var(--accent-text)" onactivate={() => openPicker("final")}>
              {#snippet mark()}<span class="p-body over"></span>{/snippet}
            </Row>
            <Row title="outbound mail" meta="administrator’s setting" metaFace="ui"
                 trail={view.reminders.outboundMail}
                 trailTone={view.reminders.outboundMail === "configured" ? "var(--ok-text)" : "var(--warm-text)"}>
              {#snippet mark()}<span class="st-glyph">↗</span>{/snippet}
            </Row>
          </div>
          {#if reminderProblem}<p class="p-error" role="alert">{reminderProblem}</p>{/if}
          {#if alertsProblem}<p class="p-error" role="alert">{alertsProblem}</p>{/if}
        {:else}
          <div class="p-unlit"></div><div class="p-unlit"></div><div class="p-unlit"></div>
        {/if}
      </div>

      <div role="tabpanel" id="st-panel-sent" aria-labelledby="st-tab-sent" hidden={tab !== "sent"}>
        {#if bothOff}
          <p class="st-warm p-prose" role="status">both off · nothing will be sent</p>
        {/if}
        {#if sent === null}
          <p class="st-say p-prose">Couldn’t load what’s been sent. Reminders still go out as set.</p>
        {:else if sent.length === 0}
          <p class="p-empty">nothing sent yet</p>
        {:else}
          <div class="st-rows st-sent">
            {#each sent as row (row.id)}
              <Row title={row.itemName} meta={sentMeta(row)} trail={when(row.at).slice(0, 6)} trailSub={when(row.at).slice(7)}
                   href={resolve("/item/[[id]]", { id: row.itemId })}>
                {#snippet mark()}
                  <span class="st-sentmark" class:failed={row.status === "failed"} class:retry={row.status === "retry"}>
                    {#if row.channel === "email"}
                      <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true"><rect x=".75" y=".75" width="16.5" height="12.5" rx="2"/><path d="M1.5 2l7.5 6 7.5-6"/></svg>
                    {:else}
                      <svg width="16" height="17" viewBox="0 0 16 17" aria-hidden="true"><path d="M3 12V7.5a5 5 0 0 1 10 0V12l1.5 1.8h-13z"/><path d="M6.3 15.6a1.8 1.8 0 0 0 3.4 0"/></svg>
                    {/if}
                  </span>
                {/snippet}
                {#snippet below()}
                  {#if row.status === "failed"}<p class="st-why over">couldn’t send · {row.reason ?? "no reason given"}</p>{/if}
                  {#if row.status === "retry"}<p class="st-why warm">still trying · {row.reason ?? "no reason given"}</p>{/if}
                {/snippet}
              </Row>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <!-- YOUR RELAY (§2.7 step 5): the address is the thing to take away. -->
    <section class="p-card" style:--i="4" aria-labelledby="st-relay">
      <h2 class="p-caps" id="st-relay">Your relay</h2>
      {#if view}
        <button class="st-address" onclick={copyAddress} disabled={view.relay.address === "no address yet"}
                aria-label={view.relay.address === "no address yet" ? "No relay address yet" : `Copy your relay address, ${view.relay.address}`}>
          <span class="st-dish" aria-hidden="true"><span></span><span></span><i></i></span>
          <span class="st-addr">{view.relay.address}</span>
          <span class="st-copy" aria-hidden="true">copy</span>
        </button>
        <div class="st-rows st-flush">
          <Row title="status" metaFace="ui" meta={view.relay.status}>
            {#snippet mark()}<span class="p-body ok breathing"></span>{/snippet}
          </Row>
          <Row title="waiting for review" meta="in your inbox" trail={String(view.waiting)} bead={view.waiting > 0}
               trailName="{view.waiting} waiting" href={resolve("/inbox")}>
            {#snippet mark()}<span class="p-paper">◆</span>{/snippet}
          </Row>
          <Row title="open the relay →" href={resolve("/settings/mail")}>
            {#snippet mark()}<span class="st-glyph"><svg class="st-icon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="2" fill="currentColor" stroke="none"/><path d="M5 5a5.6 5.6 0 0 0 0 8M13 5a5.6 5.6 0 0 1 0 8M2.6 2.6a9 9 0 0 0 0 12.8M15.4 2.6a9 9 0 0 1 0 12.8"/></svg></span>{/snippet}
          </Row>
        </div>
      {:else}
        <div class="p-unlit"></div><div class="p-unlit"></div>
      {/if}
    </section>

    <!-- YOUR SYSTEMS (§2.7 step 6): each row is the way into one. -->
    <section class="p-card" style:--i="5" aria-labelledby="st-systems">
      <h2 class="p-caps" id="st-systems">Your systems</h2>
      {#if view}
        <div class="st-rows st-flush">
          {#each view.memberships as membership (membership.id)}
            <Row title={membership.name}
                 meta={`${membership.memberCount ?? "?"} member${membership.memberCount === 1 ? "" : "s"} · ${membership.itemCount} item${membership.itemCount === 1 ? "" : "s"}`}
                 trail={membership.role} trailTone={membership.role === "owner" ? "var(--accent-text)" : ""}
                 href={resolve("/household/[id]", { id: membership.id })}>
              {#snippet mark()}
                <svg class="st-system" width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="10" fill="none"/><circle class="st-sysbody" cx="13" cy="13" r="2.6" style:fill="var({membership.primary ? "--sun" : "--ink-mid"})"/></svg>
              {/snippet}
            </Row>
          {/each}
        </div>
      {:else}
        <div class="p-unlit"></div><div class="p-unlit"></div>
      {/if}
    </section>

    <!-- WHERE YOU'RE SIGNED IN (§2.7 step 7): sign out is management, so a
         tap opens the row (review round §1.1); every device at once arms. -->
    <section class="p-card danger st-sessions" style:--i="6" aria-labelledby="st-signedin">
      <h2 class="p-caps" id="st-signedin">Where you’re signed in</h2>
      <div class="st-rows st-flush" data-row-group>
        {#each sessions as row (row.id)}
          <Row title={row.device}
               meta={row.current ? "this device" : row.lastSeenAt ? `last seen ${agoLong(row.lastSeenAt, now)}` : "never used"}
               acts={[{ label: "sign out", name: `Sign out of ${row.device}${row.current ? " (this device)" : ""}`, danger: true, onact: () => signOutOf(row) }]}>
            {#snippet mark()}
              <span class="st-device" class:here={row.current}>
                {#if onPhone(row.device)}
                  <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden="true"><rect x=".75" y=".75" width="12.5" height="18.5" rx="2.5"/><path d="M5 16.5h4"/></svg>
                {:else}
                  <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true"><rect x="1.75" y=".75" width="16.5" height="11" rx="1.5"/><path d="M.5 15h19"/></svg>
                {/if}
              </span>
            {/snippet}
          </Row>
        {/each}
        {#if sessions.length === 0 && !sessionsProblem}
          <div class="p-unlit"></div>
        {/if}
      </div>
      {#if sessionProblem}<p class="p-error" role="alert">{sessionProblem}</p>{/if}
      {#if sessionsProblem}<p class="p-error" role="alert">{sessionsProblem}</p>{/if}
      <p class="st-hint p-prose" aria-hidden="true">tap a device to sign it out</p>
      <div class="st-foot">
        <ArmButton label="sign out of every device →" armedLabel="tap again to sign out everywhere" wide
                   onfire={signOutEverywhereNow} />
        {#if everywhereProblem}<p class="p-error" role="alert">{everywhereProblem}</p>{/if}
      </div>
    </section>
  </main>

  <!-- The warning picker (§2.7 step 4): a callout, one tap chooses. -->
  <Sheet bind:open={pickerOpen} size="list" title={picking === "final" ? "Final warning" : "First warning"}>
    <p class="st-say p-prose">
      {picking === "final" ? "How close to the date the last reminder lands." : "How far ahead Orbit first tells you."}
      Items with their own timing keep it.
    </p>
    <div class="st-choices" role="radiogroup" aria-label={picking === "final" ? "Final warning" : "First warning"}>
      {#each choices as days (days)}
        {@const chosen = view ? (picking === "first" ? view.reminders.firstWarningDays : view.reminders.finalWarningDays) === days : false}
        <button class="st-choice" role="radio" aria-checked={chosen} onclick={() => pick(days)}>
          <span>{beforeWord(days)}</span>{#if chosen}<b aria-hidden="true">●</b>{/if}
        </button>
      {/each}
    </div>
  </Sheet>

  <!-- The recent-authentication callout (§17): the door's card, asking the
       reader to prove it is them before a sign-in method changes. -->
  <Sheet bind:open={methodOpen} size="callout" title={methodTitle}>
    {#if action === "password_remove"}
      <p class="st-say p-prose">You’ll sign in with your identity provider from now on.</p>
    {:else if action?.startsWith("unlink:")}
      <p class="st-say p-prose">You’ll sign in with your password from now on.</p>
    {:else}
      <p class="st-say p-prose">Orbit asks you to confirm it’s you before a way in changes.</p>
    {/if}
    {#if hasPassword || proven}
      <form id="st-method-form" class="st-form" onsubmit={(event) => { event.preventDefault(); confirmMethod(); }}>
        {#if hasPassword}
          <label class="st-label" for="st-current">your current password</label>
          <input id="st-current" class="st-input" type="password" autocomplete="current-password"
                 enterkeyhint={wantsNew ? "next" : "done"} bind:value={currentPassword}>
        {:else}
          <p class="st-proven p-prose">✓ your identity provider confirmed it’s you</p>
        {/if}
        {#if wantsNew}
          <label class="st-label" for="st-new">new password</label>
          <input id="st-new" class="st-input" type="password" autocomplete="new-password" minlength="12"
                 enterkeyhint="done" bind:value={newPassword}>
        {/if}
      </form>
    {/if}
    {#if methodProblem}<p class="p-error" role="alert">{methodProblem}</p>{/if}
    {#snippet foot()}
      {#if hasPassword || proven}
        <button class="p-pill filled" type="submit" form="st-method-form"
                disabled={methodBusy || (hasPassword && !currentPassword) || (wantsNew && !newPassword)}>
          {methodBusy ? "saving…" : confirmLabel}</button>
      {:else}
        <button class="p-pill filled" onclick={toProvider}>confirm with your identity provider →</button>
      {/if}
    {/snippet}
  </Sheet>
</div>

<style>
  /* THE DIALECT SWITCH: the same query as $lib/pocket/media.js. The desk's
     sky and cards go; its chrome stays, because on a phone Chrome.svelte
     draws the kit's top chrome and the hatch. */
  .st-pocket{display:none}
  @media (max-width:900px), (max-height:600px){
    .st-pocket{display:block;position:relative;min-height:100dvh}
    :global(.helm-page > :is(.sky, .vignette, .page)){display:none}
    :global(div.helm-page){min-height:0}
  }

  .st-column{position:relative;z-index:2;box-sizing:border-box;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 8px) var(--p-gutter)
      calc(96px + env(safe-area-inset-bottom))}
  .st-head{margin:4px 0 20px}
  .st-levers{margin:8px 0 0;color:var(--ink-quiet)}

  /* Rows run to the card's edge, as the household's do. */
  .st-rows{margin:0 calc(var(--p-card-pad) * -1)}
  .st-flush{margin-bottom:-8px}

  /* YOU: the avatar ring with a slow body on it, the desk's accent orbit. */
  .st-id{display:flex;align-items:center;gap:14px;margin:0 0 4px}
  .st-avatar{position:relative;flex:none;box-sizing:border-box;width:44px;height:44px;border-radius:50%;
    border:1.5px solid var(--accent);background:var(--panel);display:grid;place-items:center;
    font:600 var(--p-type-meta)/1 var(--mono);color:var(--ink)}
  .st-avatar::after{content:"";position:absolute;inset:-6px;border-radius:50%;
    background:radial-gradient(circle at 50% 0, var(--accent) 0 2.5px, transparent 3px);
    animation:st-orbit 14s linear infinite}
  @keyframes st-orbit{to{transform:rotate(360deg)}}
  :global([data-theme=retrograde]) .st-avatar{box-shadow:0 0 10px -2px var(--bloom)}
  .st-who{min-width:0;display:flex;flex-direction:column;gap:2px}
  .st-who b{font:600 var(--p-type-sheet)/1.25 var(--display);color:var(--ink);overflow-wrap:anywhere}
  .st-who span{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet);overflow-wrap:anywhere}
  .st-sub{margin:20px 0 4px}
  .st-glyph{font:var(--p-type-body)/1 var(--mono);color:var(--accent-text)}
  .st-glyph.off{color:var(--ink-quiet)}
  .st-icon{display:block;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}

  /* YOUR SKY: 112x88 tiles in a strip that scrolls sideways (§2.7 step 3). */
  .st-packs{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;
    margin:0 calc(var(--p-card-pad) * -1);padding:4px var(--p-card-pad) 6px;
    scroll-padding:0 var(--p-card-pad)}
  .st-packs::-webkit-scrollbar{display:none}
  .st-pack{appearance:none;flex:none;width:112px;height:88px;padding:0;border:0;background:none;cursor:pointer;
    display:flex;flex-direction:column;gap:6px;scroll-snap-align:start;-webkit-tap-highlight-color:transparent}
  .st-swatch{position:relative;display:block;width:112px;height:62px;border-radius:12px;overflow:hidden;
    border:1px solid var(--line);box-sizing:border-box;
    transition:outline-color var(--p-arm),transform var(--p-spring) var(--p-ease)}
  .st-swatch i{position:absolute;border-radius:50%}
  .st-swatch .st-sun{left:12px;top:12px;width:30px;height:30px;animation:st-sunrise 6s ease-in-out infinite alternate}
  @keyframes st-sunrise{to{transform:translate(4px, -2px)}}
  .st-packname{font:var(--p-type-meta)/1.2 var(--mono);color:var(--ink-mid);text-align:left;padding-left:2px;
    white-space:nowrap}
  .st-pack[aria-pressed=true] .st-swatch{outline:2px solid var(--accent);outline-offset:2px}
  .st-pack[aria-pressed=true] .st-packname{color:var(--accent-text)}
  .st-pack:active .st-swatch{transform:scale(.96)}
  .st-pack{border-radius:12px}
  .st-pack:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  :global([data-theme=retrograde]) .st-pack[aria-pressed=true] .st-swatch{box-shadow:0 0 12px -2px var(--bloom)}

  /* REMINDERS' head: §22 under 560px, the pair wraps under the heading. */
  .st-cardhead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 8px}
  .st-cardhead .p-caps{margin:0}
  .st-tabs{display:flex;border:1px solid var(--line);border-radius:calc(var(--p-hit) / 2);overflow:hidden;flex:1 1 100%}
  .st-tabs button{appearance:none;flex:1;min-height:var(--p-hit);padding:0 6px;white-space:nowrap;border:0;background:none;
    font:var(--p-type-meta)/1.2 var(--mono);color:var(--ink-mid);cursor:pointer;
    transition:background-color var(--p-arm),color var(--p-arm)}
  .st-tabs button + button{border-left:1px solid var(--line)}
  .st-tabs button[aria-selected=true]{background:var(--accent);color:var(--bg);font-weight:600}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .st-tabs button[aria-selected=true]{color:#fff}
  :global([data-theme=retrograde]) .st-tabs button[aria-selected=true]{box-shadow:0 0 12px -2px var(--bloom)}
  .st-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:-4px}
  [role=tabpanel]{animation:st-panel 240ms var(--p-ease) both}
  @keyframes st-panel{from{opacity:0;transform:translateY(4px)}}

  /* The switch: 52x32 drawn, 44 tall hit (§1.7), the household's own. */
  .st-switch{appearance:none;box-sizing:border-box;width:56px;height:var(--p-hit);padding:0;border:0;background:none;
    display:grid;place-items:center;cursor:pointer;-webkit-tap-highlight-color:transparent;margin-right:-6px}
  .st-switch i{position:relative;box-sizing:border-box;width:46px;height:28px;border-radius:14px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 60%, transparent);
    transition:background-color var(--p-spring),border-color var(--p-spring)}
  .st-switch i::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
    background:var(--ink-quiet);transition:transform var(--p-spring) var(--p-ease),background-color var(--p-spring)}
  .st-switch[aria-checked=true] i{background:color-mix(in srgb, var(--accent) 30%, transparent);border-color:var(--accent)}
  .st-switch[aria-checked=true] i::after{transform:translateX(18px);background:var(--accent)}
  /* Saving: the knob breathes while the answer is out. */
  .st-switch[aria-busy=true] i::after{animation:p-breathe 1.2s ease-in-out infinite}
  .st-switch:disabled{cursor:default;opacity:.45}
  :global([data-theme=retrograde]) .st-switch[aria-checked=true] i::after{box-shadow:0 0 8px var(--bloom)}
  /* The ring on the button itself, round the drawn track. */
  .st-switch{border-radius:18px}
  .st-switch:focus-visible{outline:2px solid var(--accent);outline-offset:-5px}

  /* SENT TO YOU LATELY (§2.8). */
  .st-warm{margin:4px 0 8px;color:var(--warm-text)}
  .st-say{margin:4px 0 12px;color:var(--ink-mid)}
  .st-sent{margin-bottom:-8px}
  .st-sentmark{display:grid;place-items:center;color:var(--ink-quiet)}
  .st-sentmark svg{fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
  .st-sentmark.failed{color:var(--overdue)}
  .st-sentmark.retry{color:var(--warm)}
  .st-why{flex:1 1 100%;margin:-6px 0 0;font:var(--p-type-meta)/1.5 var(--ui)}
  .st-why.over{color:var(--overdue-text)}
  .st-why.warm{color:var(--warm-text)}
  .st-sent :global(.p-row-below:not(:has(*))){display:none}

  /* YOUR RELAY: the address as a dashed pill with the dish listening in it. */
  .st-address{appearance:none;box-sizing:border-box;width:100%;min-height:52px;margin:0 0 4px;padding:6px 14px 6px 10px;
    display:flex;align-items:center;gap:10px;border-radius:26px;cursor:pointer;
    border:1px dashed color-mix(in srgb, var(--accent) 55%, var(--line));
    background:color-mix(in srgb, var(--accent) 6%, var(--panel));-webkit-tap-highlight-color:transparent;
    transition:background-color 120ms,border-color 120ms}
  .st-address:active{background:color-mix(in srgb, var(--accent) 16%, var(--panel));border-style:solid}
  .st-address:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .st-address:disabled{cursor:default;border-color:var(--line);background:var(--panel)}
  .st-address:disabled :is(.st-addr, .st-copy){color:var(--ink-quiet)}
  .st-addr{flex:1;min-width:0;text-align:left;font:var(--p-type-meta)/1.35 var(--mono);color:var(--accent-text);
    overflow-wrap:anywhere}
  /* #1137: --ink-quiet reads 4.49:1 here on after dark (the accent-tinted
     dashed pill lightens the card's own ground), under the 4.5:1 floor — the
     same step up .st-packname (below) already uses for a quiet label on
     this screen. --ink-mid clears the law on every pack with room to spare. */
  .st-copy{flex:none;font:var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ink-mid)}
  .st-dish{position:relative;flex:none;width:28px;height:28px}
  .st-dish i{position:absolute;inset:11px;border-radius:50%;background:var(--ok)}
  .st-dish span{position:absolute;inset:0;border:1px solid var(--ok);border-radius:50%;opacity:0;
    animation:st-listen 3s ease-out infinite}
  .st-dish span + span{animation-delay:1.5s}
  @keyframes st-listen{0%{transform:scale(.35);opacity:.9}100%{transform:scale(1);opacity:0}}

  .st-system{overflow:visible}
  .st-system circle:first-child{stroke:var(--chart-line, var(--line));stroke-width:1.2}

  /* WHERE YOU'RE SIGNED IN: the danger card; this device's mark is lit. */
  .st-device{display:grid;place-items:center;color:var(--ink-quiet)}
  .st-device svg{fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round}
  .st-device.here{color:var(--ok)}
  .st-hint{margin:10px 0 0;color:var(--ink-quiet)}
  .st-foot{margin:12px 0 0}

  /* The callouts. */
  .st-choices{display:flex;flex-direction:column;margin:0 0 4px}
  .st-choice{appearance:none;display:flex;align-items:center;justify-content:space-between;min-height:52px;
    padding:0 4px;border:0;border-bottom:1px solid var(--line-soft);background:none;cursor:pointer;
    font:var(--p-type-body)/1.2 var(--ui);color:var(--ink);text-align:left}
  .st-choice:last-child{border-bottom:0}
  .st-choice[aria-checked=true]{color:var(--accent-text)}
  .st-choice b{font-size:var(--p-type-meta);color:var(--accent)}
  .st-choice:active{background:var(--panel-raised)}
  .st-choice:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}
  .st-form{display:flex;flex-direction:column}
  .st-label{display:block;font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ink-quiet);margin:4px 0 6px}
  .st-input{box-sizing:border-box;width:100%;min-height:48px;padding:0 14px;margin:0 0 12px;border-radius:12px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 55%, transparent);color:var(--ink);
    font:var(--p-type-body)/1.2 var(--ui)}
  .st-input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  .st-proven{margin:0 0 12px;color:var(--ok-text)}

  @media (prefers-reduced-motion:reduce){
    [role=tabpanel],.st-avatar::after,.st-swatch .st-sun,.st-dish span{animation:none}
    .st-dish span{opacity:.5}
  }
</style>
