<script>
  import { onMount } from "svelte";

  import SignIn from "$lib/flight/SignIn.svelte";
  import { isApplicationRelative } from "$lib/return-path.js";

  /*
   * Where to land the reader after they sign in (#789, owner 2026-09-03).
   *
   * The gate sends someone who asked for a screen here as
   * /login?returnTo=%2Fsettings, and this carries that through to SignIn's
   * existing returnTo prop so they arrive where they were going rather than at
   * the front door. Nothing about the ratified screen changes; only the
   * address the button eventually points at.
   *
   * Read in `onMount` rather than from the page's URL, because this route is
   * prerendered: a build-time read would bake one reader's destination into
   * the static HTML every reader is served. Defaulting to "/" until the
   * browser answers also keeps the ratified behaviour intact — a reader who
   * comes to /login directly still meets the switchboard.
   */
  let returnTo = $state("/");

  onMount(() => {
    const asked = new URLSearchParams(location.search).get("returnTo");
    if (isApplicationRelative(asked)) returnTo = /** @type {string} */ (asked);
  });

  /**
   * The sign-in, at its own address.
   *
   * The screen itself lives in $lib/flight/SignIn.svelte because "/" serves it
   * too after the #410 cutover, and because it is one half of a pair: the
   * ratified launch departs from this dawn and the ratified descent lands on
   * its dusk (§15, owner 2026-08-16 — "they ship as THE login and logout
   * screens for every user, every time").
   *
   * Reached directly, this is the door and nothing else: a reader who is
   * already signed in and asks for the door is shown the door. "/" is the
   * front of the building and hands them on instead.
   */
</script>

<SignIn {returnTo} />
