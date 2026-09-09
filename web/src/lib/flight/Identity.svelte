<script>
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
   *   mode: "signin" | "create" | "setup",
   *   email?: string,
   *   displayName?: string,
   *   password?: string,
   *   again?: string,
   *   provider?: boolean,
   *   busy?: boolean,
   *   message?: string,
   *   onsubmit?: () => void,
   *   onprovider?: () => void,
   * }}
   */
  let {
    mode,
    email = $bindable(""),
    displayName = $bindable(""),
    password = $bindable(""),
    again = $bindable(""),
    /* create mode only: whether there is an identity provider to offer */
    provider = false,
    busy = false,
    /* Orbit's own words for a refusal, never the server's (door-state.js's
       cardMessageFor); "" while there is nothing to say */
    message = "",
    onsubmit = () => {},
    onprovider = () => {},
  } = $props();

  const asksEmail = $derived(mode !== "setup");
  const asksName = $derived(mode === "create");
  const asksAgain = $derived(mode === "setup");

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
        : "Choose a password",
  );

  /* The refusal line carries whichever is true: the host's answer from the
     server, or the local mismatch. The mismatch wins while it stands, because
     it is the thing the reader can fix without pressing anything. */
  const said = $derived(mismatched ? "Those two passwords are not the same." : message);
</script>

<div id="formlayer">
  <form class="card" aria-label={heading}
        onsubmit={(event) => { event.preventDefault(); if (ready && !busy) onsubmit(); }}>
    {#if asksEmail}
      <div class="field">
        <label for="idemail">email</label>
        <!-- `username` rather than `email`: the field accepts the account's
             email address and the owner's ruling calls it "email (or
             username)", so a password manager should treat it as the
             identifier it is. -->
        <input id="idemail" type="email" autocomplete="username" spellcheck="false"
               autocapitalize="none" autocorrect="off" inputmode="email"
               aria-label="Email address" bind:value={email} />
      </div>
    {/if}

    {#if asksName}
      <div class="field">
        <label for="idname">your name</label>
        <input id="idname" type="text" autocomplete="name"
               aria-label="Your display name" bind:value={displayName} />
      </div>
    {/if}

    <div class="field">
      <label for="idpassword">password</label>
      <input id="idpassword" type="password"
             autocomplete={mode === "signin" ? "current-password" : "new-password"}
             aria-label="Password" bind:value={password} />
      {#if !asksAgain}
        <p class="err" class:shown={Boolean(said)} role="alert">{said}</p>
      {/if}
    </div>

    {#if asksAgain}
      <div class="field">
        <label for="idagain">password again</label>
        <input id="idagain" type="password" autocomplete="new-password"
               aria-label="Password again" bind:value={again} />
        <p class="err" class:shown={Boolean(said)} role="alert">{said}</p>
      </div>
    {/if}

    <!-- THE ONE PROVIDER LINE (§2.7, verbatim: "when OIDC is enabled a single
         'continue with your identity provider' line sits under the fields
         instead of a gate"). It is under the fields and above the act, in the
         note's own voice, so the card still has exactly one pill on it. -->
    {#if mode === "create" && provider}
      <p class="note">
        <button type="button" class="quietline" onclick={onprovider}>continue with your identity provider</button>
      </p>
    {/if}

    <button class="act" id="idbtn" type="submit" disabled={!ready || busy}>{label}</button>
  </form>
</div>
