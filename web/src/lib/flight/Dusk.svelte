<script>
  import { onMount } from "svelte";
  import { door, image, duskMarkup } from "$lib/door-host.js";
  import "$lib/door/door.css";
  import "./flight.css";
  import "./door-phone.css";

  /**
   * THE DUSK — where the descent sets down, and, since §15's 2026-08-17
   * batch, the whole of what logging out means: the descent IS the default
   * logout. Dawn to log in, dusk to log out — the family rule the owner kept
   * in the same breath as the launch (§15).
   *
   * The dusk itself is orbit-site's (#1371): its markup is the shared
   * folder's `duskMarkup`, its stars and glows are mounted by the folder's
   * `door.dusk()`, which decodes its pictures ahead of the beat that shows
   * them (#1299), and its look is the folder's door.css. Orbit's goodbye keeps
   * Orbit's look (owner, 2026-10-10): it is the dusk dressed as the dawn
   * (`asDawn`), so it matches the sign-in, with the lit ring, the gold planet
   * and the Earth's photo, and the farewell hung under the way back in. The
   * farewell is plain text, which the folder escapes. Orbit's own parts ride
   * in its slots: the way back in (`gate`, markup the caller writes: the
   * LOGIN'S OWN GATE, §15, 2026-08-17, an `a.gate` the folder styles) and,
   * where the goodbye is the screen, the one heading the screen-reader walk
   * expects (#496, #843).
   *
   * THE LANDMARK (#1371 spec item 9). /logout is the goodbye itself (`page`):
   * Orbit's own main landmark holds the dusk, with the visually hidden heading in the
   * dusk's foot. The goodbye played in place over another page (Leave.svelte,
   * #1253) becomes that page's last screen only at the farewell, when the
   * page's own landmark and heading have withdrawn: until then it is no landmark
   * and its heading is hidden, and at the farewell (`landmark`) it carries
   * both, the dusk itself never redrawn. There the landmark is the folder's
   * `#dusk` surface itself, as it was before the import, not the wrapper: the
   * wrapper is an empty box left in the page's flow (on a phone, under
   * settings' long column), so a landmark on it would send a reader to a
   * blank spot instead of the goodbye, and would stand for a piece of the
   * page left over the dusk (sign-out-descent.spec.ts, #1253).
   */
  let {
    /* the way back in, as markup: the caller's own link */
    gate = "",
    /* the goodbye is the page (/logout) */
    page = false,
    /* the goodbye played over another page has become its screen */
    landmark = false,
  } = $props();

  /* the goodbye's words, as text: the folder escapes them */
  const SAID = "You are signed out.";
  const SUB = "the sky keeps turning · your systems keep their orbits";

  // svelte-ignore state_referenced_locally
  const markup = page
    ? ""
    : duskMarkup({ image, gate, farewell: { said: SAID, sub: SUB }, asDawn: true, foot: '<h1 class="sr-only" hidden>Orbit — signed out</h1>' });

  /** @type {HTMLElement | undefined} */
  let host = $state();

  onMount(() => {
    const surface = /** @type {HTMLElement} */ (host?.querySelector("#dusk"));
    /* shown by the body's classes (showdusk), as the folder's sheet has it */
    surface.hidden = false;
    /* the goodbye's lit look follows `html.rich`, as the dawn's does (the
       folder's door.css); taken off again only if it was this that put it on */
    const root = document.documentElement;
    const addedRich = !root.classList.contains("rich");
    root.classList.add("rich");
    const dusk = door.dusk(surface);
    dusk.start();
    return () => {
      dusk.destroy();
      if (addedRich) root.classList.remove("rich");
    };
  });

  $effect(() => {
    if (page) return;
    const heading = host?.querySelector("h1.sr-only");
    if (heading) /** @type {HTMLElement} */ (heading).hidden = !landmark;
    const surface = host?.querySelector("#dusk");
    if (landmark) surface?.setAttribute("role", "main");
    else surface?.removeAttribute("role");
  });
</script>

{#if page}
  <!-- #843: one landmark and one heading, sr-only because the goodbye is told
       entirely by the dusk's own art, not by document text -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- the shared door's own markup (markup.js, pure strings), with Orbit's slots: fixed markup and text escaped here (#1371) -->
  <main class="dusk-host" bind:this={host}>{@html duskMarkup({ image, gate, farewell: { said: SAID, sub: SUB }, asDawn: true, foot: '<h1 class="sr-only">Orbit — signed out</h1>' })}</main>
{:else}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- the shared door's own markup (markup.js, pure strings), with Orbit's slots: fixed markup and text escaped here (#1371) -->
  <div class="dusk-host" bind:this={host}>{@html markup}</div>
{/if}
