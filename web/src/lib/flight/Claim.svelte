<script>
  /**
   * THE CLAIM CARD (#914, plan §2.7; ADR-0022 §1–§2).
   *
   * The first thing anyone ever sees of a new Orbit, and the only thing:
   * until the instance is claimed there is no Sign in gate on this screen at
   * all, because there is nobody to sign in as and no provider that would
   * take them.
   *
   * The composition is the owner's, ruled 2026-09-09 (design/owner-decisions.md;
   * #906 closed as superseded): the first-household card — the ring holding
   * the questions, `$lib/ringcard.css` — repurposed for one field, "claim
   * code", and one sentence saying where the code is.
   *
   * WHERE THE CODE IS is said out loud because it is the whole of what an
   * operator has to know here, and it is the one place they will not think to
   * look: the code is printed once, as the last line of the container's own
   * start-up log, and lives nowhere else — no file, no environment variable,
   * nothing the installer ever saw (ADR-0022's own reversal of the 2026-08-16
   * ruling). If they arrived by the link in that notice they never read this
   * sentence at all: the host fills the field from the URL fragment and
   * submits it before this card is ever pressed.
   *
   * This component is the form and only the form: the host owns the stage,
   * the ring, the fragment, the POST and what happens next — the same
   * division CreateSystem.svelte draws.
   */
  /**
   * @type {{
   *   claim?: string,
   *   busy?: boolean,
   *   message?: string,
   *   onsubmit?: () => void,
   * }}
   */
  let {
    /* the typed (or pasted, or fragment-filled) code, owned by the host so it
       can put the link's own code in without going through the keyboard */
    claim = $bindable(""),
    busy = false,
    /* Orbit's own words for a refusal, never the server's (door-state.js's
       cardMessageFor); "" while there is nothing to say */
    message = "",
    onsubmit = () => {},
  } = $props();

  const typed = $derived(claim.trim());
</script>

<div id="formlayer">
  <form class="card" aria-label="Claim this Orbit"
        onsubmit={(event) => { event.preventDefault(); onsubmit(); }}>
    <div class="field">
      <label for="claimcode">claim code</label>
      <!-- autocomplete off and no name: this value is a one-use secret and
           has no business in a browser's saved-form store. -->
      <input id="claimcode" type="text" autocomplete="off" spellcheck="false"
             autocapitalize="characters" autocorrect="off"
             placeholder="ABCD-EFGH-…" aria-label="Claim code"
             bind:value={claim} />
      <p class="err" class:shown={Boolean(message)} role="alert">{message}</p>
    </div>

    <!-- The one line the card says by itself: the exact command, because
         "check the logs" is not an instruction anyone can follow at 2am on a
         machine they installed an hour ago. -->
    <p class="note">Run <b>docker compose logs orbit-app</b> and read the last line.</p>

    <button class="act" id="claimbtn" type="submit" disabled={!typed || busy}>Continue</button>
  </form>
</div>
