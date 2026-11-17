<script>
  import { onDestroy } from "svelte";
  import { resolve } from "$app/paths";
  import { ringFocusIn, ringFocusOut, ringOpens } from "./ring-closes.js";
  import { refusalMoment } from "./door-state.js";

  onDestroy(ringOpens);

  /**
   * THE IDENTITY CARD (#914, plan §2.7; ADR-0022 §2, ADR-0023 §1, §3, §4).
   *
   * One card, three of the four modes the owner ruled on 2026-09-09
   * (design/owner-decisions.md; #906 closed as superseded). The claim code is
   * the fourth and has its own file, because it asks for a secret rather than
   * for a person.
   *
   *   `signin` — a claimed instance where local accounts are a way in: email
   *     (or username — the field accepts the account's email) and password.
   *     The ring holds it outright on a local-only instance; in mixed mode
   *     the quiet "local login" line under the ratified gate opens it.
   *
   *   `create` — straight after a successful claim: the identity of the first
   *     administrator, which is email, display name and password. When an
   *     identity provider is configured, ONE line sits under the fields
   *     offering it — not a gate, because the reader has already been handed
   *     the instance and a second pill would read as a second decision.
   *
   *   `setup` — `/setup/<token>`: password, and password again. The address
   *     itself is the authorisation, so the card asks who nobody is; the
   *     server knows whose token it is and never says.
   *
   *   `renew` — the fifth mode (#1881, design/v19/password-after-refusal/
   *     round-1/r-the-card-again.html, owner verdict 2026-11-17): the setup
   *     mode's two fields after a sign-in whose password a "This wasn't me"
   *     marked, with one sentence above them saying when and why, and the
   *     two rules under the first. `lapsed` is its one state with no fields:
   *     the hold ran out, and the way on is the door.
   *
   * WHY ONE COMPONENT AND NOT THREE. The owner ruled "the same card" in every
   * one of these places. Three files would each be free to drift a padding or
   * a word, and the fidelity gate would only catch it screen by screen; one
   * file with a mode cannot.
   *
   * WHAT THIS CARD NEVER SAYS. Which field was wrong — the sign-in route
   * answers an unknown address, a wrong password, a disabled account and an
   * account with no password identically on purpose, and a card that narrowed
   * that down would hand back exactly what the route refused. Whether a setup
   * link was unknown, spent or expired, for the same reason.
   *
   * This component is the form and only the form: the host owns the stage,
   * the ring, the POST and where the reader lands — the same division
   * CreateSystem.svelte draws.
   */
  /**
   * @type {{
   *   mode: "signin" | "create" | "setup" | "renew",
   *   email?: string,
   *   displayName?: string,
   *   password?: string,
   *   again?: string,
   *   provider?: boolean,
   *   busy?: boolean,
   *   message?: string,
   *   onsubmit?: () => void,
   *   onprovider?: () => void,
   *   signInLine?: boolean,
   *   refusedAt?: string | null,
   *   lapsed?: boolean,
   *   onsignin?: (() => void) | null,
   * }}
   */
  let {
    mode,
    email = $bindable(""),
    displayName = $bindable(""),
    password = $bindable(""),
    again = $bindable(""),
    /* whether there is an identity provider to offer: on the create card,
       and on the sign-in card a mixed door opens (#1278) */
    provider = false,
    busy = false,
    /* Orbit's own words for a refusal, never the server's (door-state.js's
       cardMessageFor); "" while there is nothing to say */
    message = "",
    onsubmit = () => {},
    onprovider = () => {},
    /* setup mode, once the link has been refused: the way on is to sign in,
       so the card offers it under the refusal (#1120, proposal §2.14) */
    signInLine = false,
    /* renew mode: when the sign-in was refused, as the server sent it (ISO);
       null, or anything not a moment, leaves the sentence without it */
    refusedAt = null,
    /* renew mode: the hold ran out before a password was saved */
    lapsed = false,
    /* renew mode, lapsed: the host's way back to its own door. The card
       stands on the door itself, so a link to /login would be a navigation
       to the page already showing. */
    onsignin = null,
  } = $props();

  /* The moment as the wording table writes it (refusalMoment): the month in
     full, and the same UTC minute formatApprovalMoment gives the mail. */
  const refusedMoment = $derived(refusalMoment(refusedAt));

  /* THE REVEAL (#1120, proposal §2.13): a 44px control on every password
     field, because a password typed on glass is typed blind. One switch for
     the card, so the two setup fields show and hide together and "those two
     passwords are not the same" can be checked by eye. Drawn on phones only;
     the desk card is ratified without it (ringcard.css hides it there). */
  let revealed = $state(false);
  const passwordType = $derived(revealed ? "text" : "password");

  const renew = $derived(mode === "renew");
  const asksEmail = $derived(mode !== "setup" && !renew);
  const asksName = $derived(mode === "create");
  const asksAgain = $derived(mode === "setup" || renew);

  /* The one refusal this card decides for itself, because it is the one the
     server cannot see: a second password that does not match the first. Said
     only once both have something in them, so it does not accuse anyone of a
     mismatch they are still halfway through typing. */
  const mismatched = $derived(asksAgain && password.length > 0 && again.length > 0 && password !== again);

  const ready = $derived(
    (!asksEmail || email.trim().length > 0)
      && (!asksName || displayName.trim().length > 0)
      && password.length > 0
      && (!asksAgain || (again.length > 0 && !mismatched)),
  );

  const label = $derived(mode === "signin" ? "Sign in" : mode === "create" ? "Create" : "Continue");
  const heading = $derived(
    mode === "signin" ? "Sign in to Orbit"
      : mode === "create" ? "Create the first administrator"
        : renew ? "Choose a new password"
          : "Choose a password",
  );

  /* The refusal line carries whichever is true: the host's answer from the
     server, or the local mismatch. The mismatch wins while it stands, because
     it is the thing the reader can fix without pressing anything. */
  const said = $derived(mismatched ? "Those two passwords are not the same." : message);
</script>

<div id="formlayer">
  <form class="card" class:renew class:lapsed={renew && lapsed} aria-labelledby="cardask"
        onfocusin={ringFocusIn} onfocusout={ringFocusOut}
        onsubmit={(event) => { event.preventDefault(); if (ready && !busy) onsubmit(); }}>
    <!-- THE QUESTION. On a phone the ring holds it (#1127 round 1, proposal
         §2.13: the heading stands where `orbit` stood). On the desk the
         ratified card carries no visible heading, so there it is read, not
         seen (door-phone.css). -->
    <h2 class="ask asklabel" id="cardask">{heading}</h2>
    <!-- WHEN, AND WHY (#1881). The refusal's moment in the mail's own words;
         nothing about who, where or how often. Lapsed, the same place says
         so, and the quiet "sign in" under the card is the way on. -->
    {#if renew}
      {#if lapsed}
        <p class="note why" role="status">This sign-in has lapsed before a new password was saved. Sign in again and choose one then.</p>
      {:else if refusedMoment}
        <p class="note why" role="status">A sign-in with this password was refused on <b>{refusedMoment}</b> — somebody else knew it. Choose a new one and you’re in.</p>
      {:else}
        <p class="note why" role="status">A sign-in with this password was refused — somebody else knew it. Choose a new one and you’re in.</p>
      {/if}
    {/if}
    {#if asksEmail}
      <div class="field">
        <label for="idemail">email</label>
        <!-- `username` rather than `email`: the field accepts the account's
             email address and the owner's ruling calls it "email (or
             username)", so a password manager should treat it as the
             identifier it is. -->
        <input id="idemail" type="email" autocomplete="username" spellcheck="false"
               autocapitalize="none" autocorrect="off" inputmode="email" enterkeyhint="next"
               aria-label="Email address" bind:value={email} />
      </div>
    {/if}

    {#if asksName}
      <div class="field">
        <label for="idname">your name</label>
        <input id="idname" type="text" autocomplete="name" enterkeyhint="next"
               aria-label="Your display name" bind:value={displayName} />
      </div>
    {/if}

    <div class="field">
      <label for="idpassword">{renew ? "new password" : "password"}</label>
      <div class="pw">
        <input id="idpassword" type={passwordType}
               autocomplete={mode === "signin" ? "current-password" : "new-password"}
               enterkeyhint={asksAgain ? "next" : "go"}
               aria-label={renew ? "New password" : "Password"}
               aria-describedby={renew ? "idrule" : undefined} bind:value={password} />
        <button type="button" class="reveal" aria-pressed={revealed}
                aria-label={revealed ? "Hide password" : "Show password"}
                onmousedown={(event) => event.preventDefault()}
                onclick={() => (revealed = !revealed)}>{revealed ? "hide" : "show"}</button>
      </div>
      {#if renew}
        <!-- the two rules the server holds, said before it has to -->
        <p class="hint" id="idrule">at least 12 characters · not the old one</p>
      {/if}
      {#if !asksAgain}
        <p class="err" class:shown={Boolean(said)} role="alert">{said}</p>
      {/if}
    </div>

    {#if asksAgain}
      <div class="field">
        <label for="idagain">{renew ? "new password again" : "password again"}</label>
        <div class="pw">
          <input id="idagain" type={passwordType} autocomplete="new-password" enterkeyhint="go"
                 aria-label={renew ? "New password again" : "Password again"} bind:value={again} />
          <button type="button" class="reveal" aria-pressed={revealed}
                  aria-label={revealed ? "Hide passwords" : "Show passwords"}
                  onmousedown={(event) => event.preventDefault()}
                  onclick={() => (revealed = !revealed)}>{revealed ? "hide" : "show"}</button>
        </div>
        <p class="err" class:shown={Boolean(said)} role="alert">{said}</p>
        {#if signInLine}
          <p class="note after"><a class="quietline" href={resolve("/login")}>sign in</a></p>
        {/if}
      </div>
    {/if}

    <!-- THE ONE PROVIDER LINE (§2.7, verbatim: "when OIDC is enabled a single
         'continue with your identity provider' line sits under the fields
         instead of a gate"). It is under the fields and above the act, in the
         note's own voice, so the card still has exactly one pill on it. -->
    {#if provider}
      <p class="note">
        <button type="button" class="quietline" onclick={onprovider}>continue with your identity provider</button>
      </p>
    {/if}

    <button class="act" id="idbtn" type="submit" disabled={!ready || busy}>{label}</button>
    {#if renew && lapsed}
      <p class="note after">
        {#if onsignin}
          <button type="button" class="quietline" onclick={onsignin}>sign in</button>
        {:else}
          <a class="quietline" href={resolve("/login")}>sign in</a>
        {/if}
      </p>
    {/if}
  </form>
</div>
