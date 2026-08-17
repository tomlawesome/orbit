<script>
  import { onMount } from "svelte";
  import Grain from "$lib/Grain.svelte";
  import Dawn from "./Dawn.svelte";
  import { clearLaunch, markLaunch } from "./arrival.js";
  import "./flight.css";

  /**
   * THE SIGN-IN (#410, §15).
   *
   * The owner ratified the login/logout flight verbatim on 2026-08-16 —
   * "nothing short of amazing... Ship these in that exact form" — and ruled in
   * the same breath that they are NOT first-run dressing: they ship as THE
   * login and logout screens for every user, every time; first-run just
   * happens to use them. So this screen is design/v19/first-run.html's login
   * layer, drawn as it draws it: the dawn limb, and — since the owner's
   * 2026-08-17 correction, applied to sheet and app together — the 2026-08-14
   * lockup on top of it: the ring large and centred, `orbit` inside it, the
   * small gold pill inside the ring beneath the word, and no ribbon and no
   * footer anywhere on the screen.
   *
   * THE HONEST DEVIATION, stated where it happens. The mockup's flight runs
   * unbroken from this button. Pressing it in the product leaves Orbit for the
   * identity provider, so the journey is cut at the departure and nowhere
   * else: the gate flashes over the mockup's own 420 → 900ms window, and at
   * 900 — exactly the beat the mockup hands over to the climb — this page
   * hands over to /api/auth/login instead. The climb itself, whole and
   * unaltered, plays on the authenticated return (see Flight.svelte and the
   * launch overlay on /home). A one-shot marker written here and consumed
   * there is what tells the landing that a genuine sign-in just happened; see
   * arrival.js for why that is honest and why it cannot replay.
   */
  let {
    /* "/" hands a signed-in reader onward rather than showing them a door
       they are already through; /login is the door itself and always draws. */
    handOnWhenSignedIn = false,
    returnTo = "/home",
  } = $props();

  let leaving = false;

  onMount(() => {
    /* A marker left over from an abandoned sign-in must never fire later. */
    clearLaunch();

    const timers = [];
    const after = (ms, fn) => timers.push(setTimeout(fn, ms));
    /* first light: the dawn breaks once on load (CON-9, POL-13) */
    const frame = requestAnimationFrame(() => after(180, () => document.body.classList.add("lit")));

    if (handOnWhenSignedIn) {
      /* Deliberately a bare fetch and not the workspace seam: the seam turns
         a 401 into a journey to the identity provider, and on the sign-in a
         401 is simply the answer to the question. */
      fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
        .then((response) => { if (response.ok) location.replace("/home"); })
        .catch(() => {});
    }

    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      document.body.classList.remove("lit");
    };
  });

  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function press(event) {
    const gate = event.currentTarget;
    if (leaving) return;
    leaving = true;
    markLaunch();
    const rm = reduced();
    setTimeout(() => gate.classList.add("flash"), rm ? 0 : 420);
    setTimeout(() => {
      location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    }, rm ? 200 : 900);
  }
</script>

<svelte:head>
  <title>Orbit — sign in</title>
</svelte:head>

<!-- The mockup's own page ground (#04060e), carried as a layer rather than as
     a rule on <body>: a stylesheet that reached the document would follow the
     reader onto every other screen once its chunk had loaded. -->
<div class="signin-stage" aria-hidden="true"></div>
<Dawn shown>
  {#snippet children()}
    <!-- `Sign in`, the ratified word (08-14), and the word the sunset's own
         pill was reworded to match. The sheet's longer
         "Continue with your identity provider" belonged to the v18 chrome
         struck on 2026-08-17 — and would not fit inside the ring in any case.
         What it said is still true and is still said, out loud, one screen
         later: pressing this leaves for the identity provider. -->
    <button class="gate" id="gate" onclick={press}>Sign in</button>
  {/snippet}
</Dawn>
<Grain slope={0.08} />
