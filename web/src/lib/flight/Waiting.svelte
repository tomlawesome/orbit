<script>
  /**
   * THE WAITING CARD (#1033, ADR-0027 §4, §8).
   *
   * The second of sign-in's two screens. The first asked for a password; this
   * one says a link is in the post and holds the tab still until somebody
   * reading that mail decides. It stands in the ring exactly where the
   * identity card stood a moment ago, so the reader has not gone anywhere --
   * the sign-in is still happening, on the same surface, and the ratified
   * dawn behind it is untouched.
   *
   * This component is the words and only the words: the host owns the poll,
   * the resend POST and where the reader lands, the same division
   * Identity.svelte draws. It never learns whose account it is, which address
   * the mail went to, or whether one went at all -- the sign-in route answers
   * a correct password and a locked mailbox identically, and a card that
   * narrowed that down would hand back what the route refused.
   *
   * ONE CONTROL, AND IT IS QUIET. "Send it again" is the note's own voice,
   * not a second pill: the act on this screen is happening in a mailbox, and a
   * gold button here would compete with the one in the mail. It goes quiet for
   * the minute after a send (ADR-0027 §8) and says when it will be back, so
   * pressing it repeatedly is not a thing a reader has to learn not to do.
   */
  /**
   * @type {{
   *   phase?: "waiting" | "denied" | "lapsed",
   *   canResendAt?: number,
   *   limited?: boolean,
   *   busy?: boolean,
   *   message?: string,
   *   onresend?: () => void,
   * }}
   */
  let {
    /* Named `phase`, not `state`: a local called `state` shadows the `$state`
       rune for the whole component. */
    phase = "waiting",
    /* Epoch milliseconds. 0 means "no wait known", which reads as ready. */
    canResendAt = 0,
    /* ADR-0027 §8's fifth send in an hour: there is nothing to gain by asking
       again, and the answer is the mail already sitting in the mailbox. */
    limited = false,
    busy = false,
    /* Orbit's own words for a refusal, never the server's; "" while there is
       nothing to say. */
    message = "",
    onresend = () => {},
  } = $props();

  /* The countdown's own clock. One tick a second while the card is up, and
     nothing at all once the wait is over, so an idle card is not a timer. */
  let now = $state(Date.now());
  $effect(() => {
    if (phase !== "waiting") return;
    const tick = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(tick);
  });

  const waitSeconds = $derived(Math.max(0, Math.ceil((canResendAt - now) / 1000)));
  const ready = $derived(!limited && waitSeconds === 0);

  const heading = $derived(
    phase === "denied" ? "This sign-in was refused"
      : phase === "lapsed" ? "That link has lapsed"
        : "Check your email",
  );
</script>

<div id="formlayer">
  <div class="card waiting" aria-label={heading}>
    <p class="waiting-head">{heading}</p>

    {#if phase === "waiting"}
      <!-- What is happening, in the order it happens: a link went out, it has
           to be opened, and then this page moves on by itself. The last part
           is the one a reader would otherwise not know, and not knowing it is
           what makes somebody close the tab and start again. -->
      <p class="note" role="status">
        We have sent a link to the address on your account. Open it, approve
        the sign-in, and this page lets you in on its own.
      </p>

      {#if limited}
        <p class="note">Check the mail we already sent — we have sent as many as we send in an hour.</p>
      {:else}
        <p class="note waiting-resend">
          {#if ready}
            <button type="button" class="quietline" id="resendapproval" disabled={busy}
                    onclick={onresend}>send it again</button>
          {:else}
            <span class="waiting-wait">you can ask for another in {waitSeconds}s</span>
          {/if}
        </p>
      {/if}
    {:else if phase === "denied"}
      <!-- The refusal is the whole message: somebody with that password was
           turned away, and the account holder is told the same thing again on
           their next successful sign-in. -->
      <p class="note">Somebody said this wasn’t them, so nobody was let in.</p>
    {:else}
      <p class="note">Nobody answered in time. Sign in again for a new link.</p>
    {/if}

    <p class="err" class:shown={Boolean(message)} role="alert">{message}</p>
  </div>
</div>
