<script>
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import {
    clearTourSeen,
    readAuthMethodsOffered,
    readSessions,
    readSettingsScreen,
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
  import { SIGN_IN_METHODS_FIXTURES } from "$lib/data/fixtures/admin.js";
  import { agoLong } from "$lib/format.js";
  import { alertsSupported, currentSubscription, disableAlerts, enableAlerts } from "$lib/push/alerts.js";
  import { relaunchTour } from "$lib/tour/relaunch.js";
  import { fillStarTiles } from "$lib/sky.js";
  import { DEFAULT_THEME, THEME_PACKS } from "$lib/theme.js";
  import Chrome from "$lib/Chrome.svelte";
  import SignInChallenge from "./SignInChallenge.svelte";
  import "./settings.css";

  /**
   * Settings — the helm (#464). Built from design/v19/settings.html
   * (ratified §13): your own controls and only yours — identity, sky,
   * reminders, relay and memberships. Instance-wide levers live on
   * Administration. Reminder timing and "sign out of every device" are both
   * live against #468's routes.
   *
   * NOTE: the composite dispatcher still sends /settings to the old engine —
   * it manages households, which this screen deliberately does not. The flip
   * is a cutover line once those journeys exist v19-side (#453).
   */
  /** @type {{ data: { fixtures: boolean } }} */
  let { data } = $props();
  /** @type {Awaited<ReturnType<typeof readSettingsScreen>> | null} */
  let view = $state(null);

  /*
   * THE v1.3.0 ROSTER, FINAL (§15, owner): star-chart, after dark, CLOUDS,
   * dawn (which now means the terminator) and retrograde — theme.js's own
   * THEME_PACKS, in the order and membership named there (#865). Atlas,
   * hanami, porcelain, miami and solarium are on the records shelf: their
   * code is gone (#865 removed atlas's own, the last one still present), and
   * what goes here is the OFFER — this card is the only place in the product
   * that makes one in words as well as colour.
   *
   * Two rows changed with the roster, and both of them because the sheet
   * ruled the picture rather than because a preference was tidied:
   *   · CLOUDS joined, carrying the lighter end of the range (owner: "one of
   *     Orbit's MAIN LIGHTER THEMES"). Its strip shows the cool white of a
   *     cloud crest and its own hazy pastel bodies.
   *   · DAWN's ground moved to the temperature story's own #d2d3d4 and its
   *     line stopped saying "first light" — that is the pair's shared light,
   *     and what this pack IS now is the crossing. The words are the sheet's:
   *     design/v19/dawn-terminator.html, "night hands the sky to day".
   * Both strips' bodies are the pastels the refresh gave the light packs, so
   * the swatch is made of the same paint as the screen it promises.
   */
  /** @type {Record<string, [string, string, string, string[]]>} */
  const META = {
    starchart: ["star-chart", "the ratified night", "#060b1c",
      ["radial-gradient(circle at 35% 30%,#fff6e6,#ffe9c4 45%,transparent 72%)", "#f0b429", "#4ade80", "#8fb8ff"]],
    afterdark: ["after dark", "lights out, ink up", "#05070d",
      ["radial-gradient(circle at 35% 30%,#ffffff,#dbe9ff 45%,transparent 72%)", "#f0b429", "#4ade80", "#7dd3fc"]],
    clouds: ["clouds", "first light, from altitude", "#eef2f9",
      ["radial-gradient(circle at 35% 30%,#9c4a10,#eda253 45%,transparent 72%)", "#f0c076", "#95cfab", "#9dbce6"]],
    dawn: ["dawn", "night hands the sky to day", "#d2d3d4",
      ["radial-gradient(circle at 35% 30%,#9c4a10,#eda253 45%,transparent 72%)", "#f0c076", "#95cfab", "#9dbce6"]],
    retrograde: ["retrograde", "the eighties, classy", "#080a14",
      ["radial-gradient(circle at 35% 30%,#fff0fb,#ff4fd8 45%,transparent 72%)", "#ffd23f", "#3ef2a0", "#2de2e6"]],
  };
  /** @type {[string, string, string, string, string[]][]} */
  const PACKS = THEME_PACKS.map((id) => [id, ...META[id]]);
  let active = $state(DEFAULT_THEME);
  /** @param {string} name */
  function pickPack(name) {
    active = name;
    document.documentElement.dataset.theme = name;
    try { localStorage.setItem("orbit-theme", name); } catch {}
  }

  /**
   * "Take the walk again" (#753, slice 3 of #477, mockup stop 8 of
   * design/v19/tour.html): clears `tourSeenAt` then goes to /home, where the
   * existing first-run trigger starts the walk at stop 1 because the record
   * now reads null. relaunchTour (relaunch.js) also arms the one-shot flag
   * that gets this SAME-session arrival past Tour.svelte's `started` guard.
   */
  function walkAgain() {
    return relaunchTour({
      clearTourSeen,
      navigateHome: () => goto(resolve("/home")),
    });
  }

  /**
   * Reminders (#468). The ratified card shows the two warning offsets as
   * VALUES — one toggle is the only control §13 draws — so the write below is
   * the flag's alone. A timing editor is undrawn: changing 14/3 has no
   * approved surface, and inventing one here would put UI on this screen the
   * owner has not seen. Awaiting design; the route already accepts the pair,
   * which is why it is read and handed straight back.
   */
  let emailReminders = $state(true);
  /** @type {string | null} */
  let reminderProblem = $state(null);

  async function toggleEmailReminders() {
    if (!view) return;
    const previous = emailReminders;
    /* Optimistic: a toggle that waits for a round trip reads as a dead
       control. The revert below is what makes that honest. */
    emailReminders = !previous;
    reminderProblem = null;
    try {
      const reminders = await writeReminders({
        emailEnabled: emailReminders,
        firstWarningDays: view.reminders.firstWarningDays,
        finalWarningDays: view.reminders.finalWarningDays,
      });
      /* The server's answer wins over the guess, sentences included. */
      view = { ...view, reminders };
      emailReminders = reminders.emailEnabled;
    } catch {
      emailReminders = previous;
      reminderProblem = "not saved — Orbit could not reach your reminder settings";
    }
  }

  /**
   * Browser alerts (#763). The same reminder arriving on a phone that is not
   * currently looking at Orbit, which is where a person is when a reminder
   * matters.
   *
   * PER DEVICE, and the label says so. A push subscription and a notification
   * permission both belong to one browser profile, so there is no account-wide
   * state to show here: a second device reads off until it is switched on
   * there. The alternative — one shared-looking switch — would show `on` to a
   * device that receives nothing.
   *
   * `alerts.js` holds the sequence; this screen holds only the three things a
   * reader sees. `supported` false hides the control rather than drawing a
   * toggle that cannot move, and the account-wide `pushNotifications`
   * preference is deliberately not drawn: it defaults on, the worker honours
   * it, and two switches for one idea is worse than one.
   */
  let alertsAvailable = $state(false);
  let browserAlerts = $state(false);
  /** @type {?string} */
  let alertsProblem = $state(null);
  let alertsBusy = $state(false);

  onMount(async () => {
    alertsAvailable = alertsSupported();
    /* The row is drawn either way, and the switch is simply held when the
       browser cannot do push. Drawing a different row instead would make this
       screen's shape depend on a browser capability, which the pixel gate
       compares against one ratified mockup — and would give the reader a
       missing control rather than a held one. */
    if (!alertsAvailable) alertsProblem = "this browser can't show alerts";
    else browserAlerts = Boolean(await currentSubscription());
  });

  async function toggleBrowserAlerts() {
    if (alertsBusy) return;
    /* Not optimistic, unlike the email toggle above: turning these on opens a
       browser permission prompt the reader has to answer, so the switch must
       not claim to be on while that prompt is still on screen. */
    alertsBusy = true;
    alertsProblem = null;
    try {
      if (browserAlerts) {
        await disableAlerts();
        browserAlerts = false;
      } else {
        await enableAlerts();
        browserAlerts = true;
      }
    } catch (error) {
      browserAlerts = Boolean(await currentSubscription());
      /* alerts.js throws AlertsError, which carries the reason as a code so
         this screen never has to match on a message. */
      const reason = /** @type {{ code?: string }} */ (error)?.code;
      alertsProblem = reason === "permission_denied"
        ? "your browser is refusing alerts. allow notifications for Orbit, then try again"
        : reason === "unconfigured"
          ? "not switched on — this Orbit has no push keys yet, which is your administrator's to set"
          : "not switched on — Orbit could not reach your alert settings";
    } finally {
      alertsBusy = false;
    }
  }

  /**
   * SIGN-IN METHODS (#915, ADR-0023 §5, §6; composition ruled in
   * docs/plans/m7-local-accounts.md §2.7).
   *
   * The line that used to say "signed in via your identity provider" was a
   * guess this build can no longer make: an account may have a password, a
   * provider identity, or both, and the reader is the one who decides which.
   * So the "You" card now lists what actually exists — the password with the
   * date it last changed, each provider with its issuer and the date it was
   * linked — and offers the change beside each.
   *
   * THE CHALLENGE IS INLINE, and it is the two-tap protocol "sign out of every
   * device" already uses below: the first tap ARMS the action and opens the
   * field under it, the confirm inside that field is the second tap. What the
   * field asks for depends on how the reader can prove themselves (ADR-0023
   * §5): somebody with a password answers with it, and somebody with only a
   * provider is sent back to that provider to authenticate again and returns
   * here carrying a short-lived proof — `?stepup=` names the action they left
   * to do, so the block re-arms itself on the way back in.
   */
  /* The cast is on the initial value rather than the declaration: a `@type`
     comment above a `$state(null)` is not picked up here (the same reason
     `view` above is cast at each of its uses), and this way the type is
     stated once, where the null is. */
  let methods = $state(/** @type {Awaited<ReturnType<typeof readSignInMethods>> | null} */ (null));
  /** Whether this instance has a provider at all — no provider, no offer to link. */
  let providerOffered = $state(false);
  /** @type {string | null} */
  let methodsProblem = $state(null);
  /**
   * Which action is armed, if any: `password_set`, `password_change`,
   * `password_remove`, `link_oidc`, or `unlink:<identity id>`.
   * @type {string | null}
   */
  let armedMethod = $state(null);
  let currentPassword = $state("");
  let newPassword = $state("");
  let methodBusy = $state(false);
  /** @type {string | null} */
  let methodOutcome = $state(null);
  /** @type {string | null} */
  let methodProblem = $state(null);
  /* There is deliberately no "am I standing on a step-up proof" flag. A reader
     with no password can only reach an armed action by coming back from one —
     `tapMethod` sends them there rather than opening a field — so `hasPassword`
     already answers which challenge is in play, and a second piece of state
     saying the same thing is a second thing that can disagree. */
  const hasPassword = $derived(methods?.local.set ?? false);
  const identities = $derived(methods?.oidc ?? []);

  /** The provider as a reader recognises it: its host, never the whole issuer URL. */
  /** @param {string} issuer */
  function issuerHost(issuer) {
    try { return new URL(issuer).host; } catch { return issuer; }
  }

  /** A date a reader can read, in UTC so the gate photographs the same one. */
  /** @param {?string} iso */
  const on = (iso) =>
    iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

  /** The step-up intent each armed action is bound to (ADR-0023 §5). */
  /** @param {string} action */
  const intentOf = (action) =>
    action.startsWith("unlink:") ? "unlink_method" : action === "password_remove" ? "unlink_method" : action;

  /**
   * The first tap. Somebody with a password gets the field; somebody without
   * one is handed to the provider, and comes back to this block re-armed.
   *
   * @param {string} action
   */
  async function tapMethod(action) {
    methodProblem = null;
    methodOutcome = null;
    currentPassword = "";
    newPassword = "";
    if (armedMethod === action) { armedMethod = null; return; }
    if (hasPassword) { armedMethod = action; return; }
    /* No password: the challenge is a fresh authentication at the provider.
       `returnTo` carries the action so this block can pick it up again. */
    const identity = action.startsWith("unlink:") ? `&identity=${encodeURIComponent(action.slice(7))}` : "";
    try {
      await startStepUp({ intent: intentOf(action), returnTo: `/settings?stepup=${encodeURIComponent(action)}${identity}` });
    } catch (error) {
      methodProblem = methodWords(error);
    }
  }

  /** What a refusal means in this block's own words, from the bounded code. */
  /** @param {unknown} error */
  function methodWords(error) {
    const code = /** @type {{ code?: string, message?: string }} */ (error)?.code;
    if (code === "recent_authentication_required") return "that isn't your current password — nothing was changed";
    if (code === "too_many_attempts") return "too many attempts at once; try again shortly";
    if (code === "password_rejected") return /** @type {{ message?: string }} */ (error)?.message ?? "that password was refused";
    if (code === "link_last_method") return "keep at least one way to sign in: add another method before removing this one";
    if (code === "link_exists") return "that provider account already belongs to an Orbit account";
    if (code === "step_up_failed") return "your identity provider did not re-authenticate you, so nothing was changed";
    if (code === "provider_handover_unreadable") {
      return "not started — Orbit could not hand you to your identity provider";
    }
    return /** @type {{ message?: string }} */ (error)?.message ?? "not changed — Orbit could not reach your sign-in methods";
  }

  /** Disarms whatever is armed, leaving the block as this reader found it. */
  function cancelMethod() {
    armedMethod = null;
    currentPassword = "";
    newPassword = "";
  }

  /** The second tap: the change itself, carrying whichever proof applies. */
  async function confirmMethod() {
    if (!armedMethod || methodBusy) return;
    methodBusy = true;
    methodProblem = null;
    /* A step-up proof is a cookie the browser carries; a password travels in
       the body. Exactly one of them is in play, never both. */
    const challenge = hasPassword ? { currentPassword } : {};
    const action = armedMethod;
    try {
      if (action === "link_oidc") {
        await startProviderLink({ returnTo: "/settings", ...challenge });
        return;
      }
      if (action === "password_set" || action === "password_change") {
        const outcome = await writeLocalPassword({ password: newPassword, ...challenge });
        methodOutcome = outcome.changed
          ? "password changed — every other device was signed out"
          : "password set";
      } else if (action === "password_remove") {
        await removeLocalPassword(challenge);
        methodOutcome = "password removed";
      } else if (action.startsWith("unlink:")) {
        await unlinkProviderIdentity(action.slice(7), challenge);
        methodOutcome = "identity provider unlinked";
      }
      armedMethod = null;
      currentPassword = "";
      newPassword = "";
      methods = await readSignInMethods();
    } catch (error) {
      methodProblem = methodWords(error);
    } finally {
      methodBusy = false;
    }
  }

  /**
   * "Where you're signed in" (#482): every session the caller holds, loaded
   * alongside the rest of the screen. Additive like the relay and reminders
   * cards above — a session list that cannot be reached costs the reader
   * that one list, not the screen, so a failure here holds an empty list and
   * says so rather than throwing.
   */
  /** @type {Awaited<ReturnType<typeof readSessions>>} */
  let sessions = $state([]);
  /** @type {string | null} */
  let sessionsProblem = $state(null);
  /** @type {Record<string, boolean>} */
  let armedRevoke = $state({});
  /** @type {Record<string, string>} */
  let revokeProblem = $state({});

  /**
   * Sign out of one device — armed by a first tap, done by a second, same
   * family protocol as `tapSignOutEverywhere` below. Ending the current
   * device's own session leaves nothing to come back to, so that case goes
   * straight to the sign-in the way `tapSignOutEverywhere` does; ending any
   * other device just drops its row.
   *
   * @param {Awaited<ReturnType<typeof readSessions>>[number]} row
   */
  async function tapRevokeSession(row) {
    revokeProblem = { ...revokeProblem, [row.id]: "" };
    if (!armedRevoke[row.id]) {
      armedRevoke = { ...armedRevoke, [row.id]: true };
      return;
    }
    try {
      await revokeSession(row.id);
      if (row.current) {
        location.assign("/login");
        return;
      }
      sessions = sessions.filter((session) => session.id !== row.id);
      armedRevoke = { ...armedRevoke, [row.id]: false };
    } catch {
      armedRevoke = { ...armedRevoke, [row.id]: false };
      revokeProblem = { ...revokeProblem, [row.id]: "still signed in — try again" };
    }
  }

  /**
   * "Sign out of every device" — armed by a first tap, done by a second, the
   * family protocol the inbox and the item view already use for anything
   * that cannot be undone. This one ends the caller's own session too, so on
   * success there is no page left to return to: the cookie is dead and the
   * sign-in is the only honest destination.
   */
  let armedSignOut = $state(false);
  /** @type {string | null} */
  let signOutProblem = $state(null);

  async function tapSignOutEverywhere() {
    signOutProblem = null;
    if (!armedSignOut) {
      armedSignOut = true;
      return;
    }
    try {
      await signOutEverywhere();
      location.assign("/login");
    } catch {
      armedSignOut = false;
      signOutProblem = "still signed in — try again";
    }
  }

  const initials = $derived(
    (/** @type {Awaited<ReturnType<typeof readSettingsScreen>> | null} */ (view)?.user?.displayName ?? "")
      .split(/\s+/).map((/** @type {string} */ part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·",
  );

  onMount(async () => {
    fillStarTiles(
      /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("fartile"))),
      /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("neartile"))),
    );
    active = document.documentElement.dataset.theme || DEFAULT_THEME;
    view = await readSettingsScreen();
    emailReminders = /** @type {Awaited<ReturnType<typeof readSettingsScreen>>} */ (view).reminders.emailEnabled;
    try {
      sessions = await readSessions();
    } catch {
      sessionsProblem = "not shown — Orbit could not reach your session list";
    }

    /* Sign-in methods (#915). Additive like the cards above: a block that
       cannot be read costs the reader that block, not the helm.

       Under fixtures there is no session to read them off — `GET
       /api/auth/methods` answers the CALLER's own rows and the harness has no
       caller — so the gate's screen is drawn from the fixture instead, the way
       administration's relay rows already are. `?signin=` names which state,
       so both can be photographed and walked. */
    const parameters = new URLSearchParams(window.location.search);
    if (data?.fixtures) {
      const wanted = parameters.get("signin") ?? "both";
      methods = /** @type {any} */ (SIGN_IN_METHODS_FIXTURES)[wanted] ?? SIGN_IN_METHODS_FIXTURES.both;
      providerOffered = true;
    } else {
      try {
        [methods, { oidc: providerOffered }] = await Promise.all([
          readSignInMethods(),
          readAuthMethodsOffered(),
        ]);
      } catch {
        methodsProblem = "not shown — Orbit could not reach your sign-in methods";
      }
    }

    /* Back from the provider (ADR-0023 §5): the proof is in a cookie the
       browser carries, and this is the action it was earned for. Re-arm it so
       the reader finishes where they left off rather than starting again. */
    const resumed = parameters.get("stepup");
    if (resumed && methods && !methods.local.set) armedMethod = resumed;
  });
</script>

<svelte:head><title>Orbit — settings</title></svelte:head>

<div class="helm-page">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view?.user} current="settings"
        role={view ? `${view.household?.name ?? ""} · ${view.household?.canManage ? "owner" : "member"}` : ""} />

<div class="page" role="main">
  <header class="screen">
    <h1>Settings</h1>
    <div class="sub">your controls, and only yours · the instance’s levers live on administration</div>
  </header>

  {#if view}
    <div class="cards">
    <div class="card wide">
      <h2>You</h2>
      <div class="idrow">
        <span class="avatar" aria-hidden="true">{initials}</span>
        <div class="who"><b>{view.user?.displayName ?? ""}</b><span>{view.user?.email ?? ""}</span></div>
        <button>edit name</button>
      </div>

      <!-- Sign-in methods (#915, ADR-0023 §6; composition §2.7). This replaces
           the single "signed in via your identity provider" line: an account
           can have a password, providers, or both, so the block says which,
           and each row carries its own way to change it. The rows are the
           card family's own .kv furniture — same type, same rhythm, nothing
           shrunk to make room. -->
      <h3 class="methods-head">Sign-in methods</h3>
      {#if methods}
        <div class="kv">
          <span>password</span>
          <span class="method">
            {#if hasPassword}
              <b>set{methods.local.changedAt ? ` · changed ${on(methods.local.changedAt)}` : ""}</b>
              <button onclick={() => tapMethod("password_change")}
                      aria-expanded={armedMethod === "password_change"}>change</button>
              <button onclick={() => tapMethod("password_remove")}
                      aria-expanded={armedMethod === "password_remove"}>remove</button>
            {:else}
              <b>not set</b>
              <button onclick={() => tapMethod("password_set")}
                      aria-expanded={armedMethod === "password_set"}>set a password</button>
            {/if}
          </span>
        </div>
        {#if armedMethod === "password_set" || armedMethod === "password_change" || armedMethod === "password_remove"}
          <SignInChallenge wantsNewPassword={armedMethod !== "password_remove"}
                           confirmLabel={armedMethod === "password_remove" ? "remove it" : "save it"}
                           hasPassword={hasPassword} busy={methodBusy} problem={methodProblem}
                           bind:currentPassword bind:newPassword
                           onconfirm={confirmMethod} oncancel={cancelMethod} />
        {/if}

        {#each identities as identity (identity.id)}
          <div class="kv">
            <span>identity provider</span>
            <span class="method">
              <b>{issuerHost(identity.issuer)} · linked {on(identity.linkedAt)}</b>
              <button onclick={() => tapMethod(`unlink:${identity.id}`)}
                      aria-expanded={armedMethod === `unlink:${identity.id}`}
                      aria-label={`unlink ${issuerHost(identity.issuer)}`}>unlink</button>
            </span>
          </div>
          {#if armedMethod === `unlink:${identity.id}`}
            <SignInChallenge confirmLabel="unlink it"
                             hasPassword={hasPassword} busy={methodBusy} problem={methodProblem}
                             bind:currentPassword bind:newPassword
                             onconfirm={confirmMethod} oncancel={cancelMethod} />
          {/if}
        {/each}

        <!-- One offer, and only where it can be taken: an instance with no
             provider configured has nothing to link to. -->
        {#if providerOffered && identities.length === 0}
          <div class="kv">
            <span>identity provider</span>
            <span class="method">
              <b>not linked</b>
              <button onclick={() => tapMethod("link_oidc")}
                      aria-expanded={armedMethod === "link_oidc"}>link your identity provider</button>
            </span>
          </div>
          {#if armedMethod === "link_oidc"}
            <SignInChallenge confirmLabel="continue to your provider"
                             hasPassword={hasPassword} busy={methodBusy} problem={methodProblem}
                             bind:currentPassword bind:newPassword
                             onconfirm={confirmMethod} oncancel={cancelMethod} />
          {/if}
        {/if}

        {#if methodOutcome}<div class="note ok">{methodOutcome}</div>{/if}
      {/if}
      {#if methodsProblem}<div class="note">{methodsProblem}</div>{/if}
    </div>

    <div class="card wide">
      <h2>Your sky</h2>
      <div class="packs" role="group" aria-label="Theme pack">
        {#each PACKS as [name, title, line, ground, [sun, warm, ok, upcoming]] (name)}
          <button class="pack" aria-pressed={active === name} onclick={() => pickPack(name)}>
            <span class="strip" style="background:{ground}" aria-hidden="true">
              <i style="left:18px;top:18px;width:26px;height:26px;background:{sun}"></i>
              <i style="left:64px;top:38px;width:7px;height:7px;background:{warm}"></i>
              <i style="left:92px;top:22px;width:5px;height:5px;background:{ok}"></i>
              <i style="left:120px;top:44px;width:4px;height:4px;background:{upcoming}"></i>
            </span>
            <span class="label"><b>{title}</b><span>{line}</span></span>
          </button>
        {/each}
      </div>
      <button class="relaunch" onclick={walkAgain}>↻ take the walk again</button>
    </div>

    <div class="card">
      <h2>Reminders</h2>
      <div class="kv"><span>email reminders</span><button class="toggle" aria-pressed={emailReminders} aria-label="Email reminders" onclick={toggleEmailReminders}><i></i></button></div>
      <div class="kv"><span>browser alerts · this device</span><button class="toggle" aria-pressed={browserAlerts} aria-label="Browser alerts on this device" disabled={alertsBusy || !alertsAvailable} onclick={toggleBrowserAlerts}><i></i></button></div>
      <div class="kv"><span>first warning</span><b>{view.reminders.firstWarning}</b></div>
      <div class="kv"><span>final warning</span><b>{view.reminders.finalWarning}</b></div>
      <div class="kv"><span>outbound mail</span><span><b class="on">{view.reminders.outboundMail}</b> · by your administrator</span></div>
      {#if reminderProblem}<div class="note">{reminderProblem}</div>{/if}
      {#if alertsProblem}<div class="note">{alertsProblem}</div>{/if}
    </div>

    <div class="card">
      <h2>Your relay</h2>
      <div class="kv"><span>address</span><b style="color:var(--accent-text)">{view.relay.address}</b></div>
      <div class="kv"><span>status</span><b class="on">{view.relay.status}</b></div>
      <div class="kv"><span>waiting for review</span><a href={resolve("/inbox")}>{view.waiting} arrival{view.waiting === 1 ? "" : "s"} — open your inbox →</a></div>
      <div class="kv"><span>rotate · pause · details</span><a href={resolve("/settings/mail")}>open the relay →</a></div>
    </div>

    <div class="card">
      <h2>Your systems</h2>
      <!-- §15-2k: this card is the door to household management. Each row is
           the way into one system — /household/{id}, the owner's screen or the
           member's depending on who is reading it. A link, not a button with a
           handler: it is a place, so it wants an address the browser can open
           in its own way. Drawn exactly as the ratified row, because a row
           becoming reachable must not become a different row. -->
      {#each view.memberships as membership (membership.id)}
        <a class="memb" href={resolve("/household/[id]", { id: membership.id })}>
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="10" fill="none" style="stroke:var(--chart-line)"/><circle cx="13" cy="13" r="2.4" style="fill:var({membership.primary ? "--sun" : "--ink-mid"})"/></svg>
          <b>{membership.name}</b><small>{membership.memberCount} member{membership.memberCount === 1 ? "" : "s"} · {membership.itemCount} item{membership.itemCount === 1 ? "" : "s"}</small><span class="role" class:owner={membership.role === "owner"}>{membership.role}</span>
        </a>
      {/each}
    </div>

    </div><!-- /cards -->

    <div class="danger">
      <h2>Where you're signed in</h2>
      <ul class="sessions-list">
        {#each sessions as row (row.id)}
          <li class="session-row">
            <div class="session-info">
              <b>{row.device}</b>
              <span>{row.current ? "this device" : row.lastSeenAt ? `last seen ${agoLong(row.lastSeenAt, new Date().toISOString())}` : "never used"}</span>
            </div>
            <button onclick={() => tapRevokeSession(row)} aria-label={`sign out of ${row.device}`}>
              {armedRevoke[row.id]
                ? `tap again to sign out${row.current ? " here" : ""}`
                : row.current ? "sign out here" : "sign out"}
            </button>
            {#if revokeProblem[row.id]}<div class="note">{revokeProblem[row.id]}</div>{/if}
          </li>
        {/each}
      </ul>
      {#if sessionsProblem}<div class="note">{sessionsProblem}</div>{/if}
      <button onclick={tapSignOutEverywhere}>{armedSignOut ? "tap again to sign out everywhere" : "sign out of every device →"}</button>{#if signOutProblem}<div class="note">{signOutProblem}</div>{/if}
    </div>
  {/if}
</div>
</div>
