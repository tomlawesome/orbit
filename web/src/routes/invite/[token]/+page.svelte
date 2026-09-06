<script>
  import { resolve } from "$app/paths";
  import { signOut } from "$lib/data/workspace.js";
  import "./invite.css";

  /**
   * WHEN THE LINK DOES NOT WORK (#481, step 5).
   *
   * A link that works never renders this: `+page.server.js` redirects to the
   * identity provider or to /home. So every state below is an ending, and each
   * one gets the same treatment — one sentence, one action, nothing to decide.
   *
   * WHAT THIS SCREEN NEVER SAYS. Not the household's name: a spent, withdrawn
   * or misaddressed link must tell whoever holds it nothing they did not
   * already have. Not the invited address, for the same reason. Not the token,
   * anywhere, ever. The inviter's chosen name IS said, because "ask Sam for a
   * new one" is the whole of what a spent link has left to offer.
   *
   * @typedef {{ state: "used" | "expired" | "withdrawn" | "unknown" | "mismatch", inviterName: string | null }} InviteOutcome
   */

  /** @type {{ data: InviteOutcome }} */
  let { data } = $props();

  /* "ask Sam" where the inviter is still an account, "ask whoever invited you"
     where they are not — the row's invited_by is ON DELETE SET NULL. */
  const asker = $derived(data.inviterName ? `ask ${data.inviterName}` : "ask whoever invited you");

  const line = $derived(
    data.state === "used"
      ? `This invitation has already been used — ${asker} for a new one.`
      : data.state === "expired"
        ? `This invitation has expired — ${asker} for a new one.`
        : data.state === "withdrawn"
          ? `This invitation was withdrawn — ${asker} for a new one.`
          : data.state === "mismatch"
            ? "This invitation was sent to a different address."
            : "This invitation link is not one Orbit recognises.",
  );

  const note = $derived(
    data.state === "mismatch"
      ? "You are signed in as somebody else. Sign out, then open the link again as the person it was written to."
      : "Nothing here is broken, and there is nothing to undo — a link that has been used or has lapsed simply stops working.",
  );

  let leaving = $state(false);

  /**
   * The one action a mismatch offers.
   *
   * `signOut` resolves only once the session row is actually gone, and hands
   * back the provider's own end-session URL when it has one — so the reader
   * ends up signed out of the provider too, which is the point: signing back
   * in as themselves is what they are here to do.
   */
  async function leave() {
    if (leaving) return;
    leaving = true;
    try {
      const providerLogout = await signOut();
      location.replace(providerLogout ?? "/logout");
    } catch {
      /* The session may already be gone; the goodbye is still the truth. */
      location.replace("/logout");
    }
  }
</script>

<svelte:head>
  <title>Orbit — invitation</title>
</svelte:head>

<main>
  <div class="invite-stage" aria-hidden="true"></div>
  <div class="invite-card">
    <div class="name">orbit</div>
    <h1>{line}</h1>
    <p class="said">{note}</p>
    {#if data.state === "mismatch"}
      <button class="gate" onclick={leave} disabled={leaving}>
        {leaving ? "signing out…" : "Sign out"}
      </button>
    {:else}
      <a class="gate" href={resolve("/")}>Go to Orbit</a>
    {/if}
  </div>
</main>
