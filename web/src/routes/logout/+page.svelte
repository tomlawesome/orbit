<script>
  import { onMount } from "svelte";
  import Grain from "$lib/Grain.svelte";
  import Dusk from "$lib/flight/Dusk.svelte";
  import "$lib/flight/flight.css";

  /**
   * SIGNED OUT — the descent's own dusk, at its own address (#410, §15).
   *
   * THE RULING (owner, 2026-08-17, re-confirming): "The descent is the default
   * logout... the old /logout sunset retires." So this route no longer draws
   * CON-17's sunset — the limb performing the day ending well, which was this
   * screen from #399 until now. It draws the surface the ratified descent sets
   * down on, which is what logging out of Orbit now looks like. The retired
   * screen's own files (logout.css, sky.js) stay in the tree as the record of
   * it, referenced by nothing, in the same way every superseded design in this
   * repository is kept rather than deleted.
   *
   * WHAT THIS ROUTE IS. It is the LANDING, not the journey. Signing out from
   * home revokes the session, plays the whole descent over the home surface
   * and then quietly replaces the address with /logout at the farewell beat —
   * the reader is already looking at this exact surface, drawn by the flight,
   * and this component never runs. What this component is for is the second
   * way a reader arrives here: typing the address, refreshing after the
   * farewell, or following a bookmark. They get the goodbye already arrived
   * at — `showdusk` and `farewell` applied at once, which is precisely what
   * the reduced-motion descent does, because the staging is class-driven.
   *
   * AND WHAT A SIGNED-IN READER GETS. Not this. Three reasons, and they all
   * point the same way:
   *
   *   · a GET must not destroy anything. /logout as a link that revokes is a
   *     one-pixel-image CSRF away from signing people out, and the app's own
   *     rule is that every destructive control arms and then fires;
   *   · this screen SAYS "You are signed out." Showing it to a live session
   *     would be a lie the interface tells before doing the work;
   *   · the goodbye is the end of the descent. It is earned by the flight, and
   *     the flight is earned by revocation completing first (see home's
   *     tapSignOut, where the POST lands before the first frame).
   *
   * So a reader who is signed in and asks for /logout is handed to /home,
   * where the sign-out control lives and where the real journey starts. The
   * check is a bare fetch of the session for the same reason the sign-in's is:
   * the workspace seam turns a 401 into a trip to the identity provider, and
   * here a 401 is simply the answer to the question — it means they are
   * already signed out, and they should see the goodbye.
   */
  onMount(() => {
    const body = document.body;
    body.classList.add("showdusk", "farewell");

    fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
      .then((response) => { if (response.ok) location.replace("/home"); })
      .catch(() => {});

    return () => body.classList.remove("showdusk", "farewell");
  });
</script>

<svelte:head>
  <title>Orbit — signed out</title>
</svelte:head>

<!-- The dusk's own page ground, carried as a layer rather than as a rule on
     <body>: a stylesheet that reached the document would follow the reader
     onto every other screen once its chunk had loaded. The sign-in does the
     same thing with the same colour. -->
<div class="signin-stage" aria-hidden="true"></div>
<Dusk>
  {#snippet children()}
    <!-- The LOGIN'S GATE, identical (§15, 2026-08-17). "/" is the front door:
         signed out it IS the sign-in, so the way back in is one hop and the
         identity provider asks its question there. -->
    <a class="gate" href="/">Sign back in</a>
  {/snippet}
</Dusk>
<Grain slope={0.08} />
