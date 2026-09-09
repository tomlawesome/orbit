<script>
  import { onMount } from "svelte";
  import Grain from "$lib/Grain.svelte";
  import Dawn from "$lib/flight/Dawn.svelte";
  import Identity from "$lib/flight/Identity.svelte";
  import { markLaunch } from "$lib/flight/arrival.js";
  import { cardMessageFor } from "$lib/flight/door-state.js";
  import "$lib/ringcard.css";
  import "$lib/flight/flight.css";

  /**
   * CHOOSING A PASSWORD (#914, plan §2.7 — the card's fourth mode).
   *
   * The owner's 2026-09-09 composition ruling: "the same card in a fourth
   * mode (password, password again) — shape of `web/src/routes/invite/
   * [token]/`". So this is the door's own surface — the dawn, the ring, the
   * card — rather than a form on a page, because it IS a way in: the reader
   * ends this screen signed in, exactly as they would ending the sign-in card.
   *
   * WHAT THIS SCREEN NEVER SAYS. Whose link it is: not the name, not the
   * address, not whether the account already had a password. A setup link
   * that reaches the wrong hands must tell them nothing they did not already
   * have — the same rule `/invite/[token]` follows, for the same reason. And
   * not which of unknown, spent or expired a refused token was: the route
   * answers one generic `setup_token_invalid` and this card repeats it.
   *
   * The chrome is off from the first frame (`showform`, set before the paint
   * that lights the sky), because there is no gate on this screen to hide
   * later: nobody arrives here to press Sign in.
   */
  /** @type {{ data: { token: string } }} */
  let { data } = $props();

  let password = $state("");
  let again = $state("");
  let busy = $state(false);
  let message = $state("");

  onMount(() => {
    document.body.classList.add("showform");
    const frame = requestAnimationFrame(() => document.body.classList.add("lit"));
    return () => {
      cancelAnimationFrame(frame);
      document.body.classList.remove("showform", "lit");
    };
  });

  /**
   * Spends the link. Same-origin with no CSRF token, because there is no
   * session to derive one from — the token in the body is the whole
   * authorisation and the route asserts same-origin instead.
   *
   * On success the browser is already signed in as whoever the token named,
   * so it goes to the front door and the ratified landing plays: the arrival
   * decides home, the create card or the newcomer's climb, exactly as it does
   * after any other way in.
   */
  async function submit() {
    if (busy) return;
    busy = true;
    message = "";
    try {
      const response = await fetch("/api/auth/local/setup", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: data.token, password }),
      });
      if (response.ok) {
        password = "";
        again = "";
        markLaunch();
        location.href = "/";
        return;
      }
      let code;
      try {
        code = (await response.json())?.error;
      } catch {
        code = undefined;
      }
      message = cardMessageFor(code);
    } catch {
      message = cardMessageFor(undefined);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Orbit — choose a password</title>
</svelte:head>

<main class="ringcard">
  <!-- One landmark, one heading. The visible title is carried by the card's
       own labels, so the heading names the screen for a reader who cannot see
       it rather than repeating text already on it — the arrival's own rule. -->
  <h1 class="sr-only">Choose a password for your Orbit account</h1>

  <div class="signin-stage" aria-hidden="true"></div>
  <Dawn shown={true} />
  <Grain slope={0.08} />

  <div class="bigring" aria-hidden="true">
    <div class="ringglass"></div>
    <div class="ringorbit"><i></i></div>
  </div>
  <Identity mode="setup" bind:password bind:again {busy} {message} onsubmit={submit} />
</main>
