<script>
  import SignIn from "$lib/flight/SignIn.svelte";

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

<SignIn />
