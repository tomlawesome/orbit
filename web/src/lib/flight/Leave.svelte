<script>
  import { tick } from "svelte";
  import Flight from "./Flight.svelte";
  import Dusk from "./Dusk.svelte";
  import { readyFlight, stopLeisure } from "./warm.js";

  /**
   * SIGNING OUT, ONE WAY EVERYWHERE (#1253; owner, 2026-10-07: "signing out
   * should always play the reverse flight. No matter where you are.").
   *
   * Everything a sign-out puts on the page after the session is ended: the
   * dusk with its "Sign back in" way, the flight that plays the descent over
   * whatever is showing, and the farewell that moves the address to /logout.
   * Home's desk menu, the pocket's hatch (through home) and Chrome's menu on
   * every other page all use this, so the three cannot drift.
   *
   * The caller revokes first (the revocation beat: a closed lid at any point
   * of the flight can never leave a live session behind) and then hands over
   * what the provider answered. A page that never signs out should not pay
   * for the flight: import this component lazily (Chrome does); home, which
   * flies the climb on the same Flight, imports it as it always imported it.
   *
   * `launching` keeps the flight mounted for the climb as well (home's own
   * launch) and `ascend` plays it; `descend` is the descent alone (home's
   * fixtures pin it to a millisecond).
   */
  let {
    /* the household's name, written on the void */
    name = "",
    /* the reader's other households, met again on the way down */
    homes = [],
    /* mount the flight before any sign-out, for the climb */
    launching = false,
    /* mount the dusk and flight from the start (home's pinned descent fixture) */
    leaving: startLeaving = false,
  } = $props();

  /** @type {import('./Flight.svelte').default | null} */
  let flight = $state(null);
  // svelte-ignore state_referenced_locally
  let leaving = $state(startLeaving);
  /* The provider's own end-session URL, kept for the way back: following it
     now would yank the reader off the ratified goodbye, so "sign back in"
     carries it instead, and the identity provider asks its question again. */
  /** @type {string | null} */
  let providerLogout = $state(null);
  const backIn = $derived(providerLogout ?? "/");

  /* #1253, #1262: the menu holds the sign-out, so when it opens the descent's
     world is readied (never a compile that would stop the page: warm.js),
     and it is there by the time the one press has revoked the session */
  export function ready() {
    readyFlight({ hurry: true, gentle: true });
  }

  /** The launch: the climb, from the page that has just been signed in to. */
  /** @param {{ at?: number }} [options] */
  export function ascend(options) {
    flight?.ascend(options);
  }

  /** The descent alone, with the dusk already mounted (a pinned fixture). */
  /** @param {{ at?: number }} [options] */
  export function descend(options) {
    flight?.descend(options);
  }

  /**
   * The descent, once the session is ended.
   * @param {string | null} redirectTo the provider's own logout URL, if any
   */
  export async function descendFrom(redirectTo) {
    /* #1299: the page's unhurried readying, if still to come, would land in
       the middle of the descent (warm.js) */
    stopLeisure();
    providerLogout = redirectTo;
    leaving = true;
    await tick();
    flight?.descend();
  }

  function onFarewell() {
    /*
     * The address catches up with the state. The descent plays over the page,
     * but the reader is signed out when it ends, and this page is no longer
     * theirs: a refresh here would bounce them at the identity provider
     * instead of showing them the goodbye. Replace, never push -- Back must
     * not walk into a signed-out page either.
     */
    try { history.replaceState(history.state, "", "/logout"); } catch { /* no history, no harm */ }
  }
</script>

{#if leaving}
  <!-- the ground under the dusk, so a daylight theme's page background never
       shows beneath it (as the sign-in's own dawn has) -->
  <div class="signin-stage" aria-hidden="true"></div>
  <Dusk>
    <!-- `backIn` is the identity provider's own end-session URL as often as
         it is "/": genuinely external, not a route this app can resolve(),
         which is what `rel="external"` tells the lint rule (and anyone
         reading the markup) rather than a suppression. -->
    <a class="again" rel="external" href={backIn}>Sign back in</a>
  </Dusk>
{/if}
{#if launching || leaving}
  <Flight bind:this={flight} {name} onfarewell={onFarewell} {homes} />
{/if}
