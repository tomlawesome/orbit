<script>
  import { onMount } from "svelte";
  import { door, image, dawnMarkup } from "$lib/door-host.js";
  import "$lib/door/door.css";
  import "./flight.css";
  import "./door-phone.css";

  /**
   * THE DAWN — the sky the launch leaves from, and the sign-in's own surface.
   *
   * The door itself is orbit-site's (#1371): its markup is the shared
   * folder's `dawnMarkup`, its stars, glows and Earth are mounted by the
   * folder's `door.dawn()`, and its look is the folder's door.css. What is
   * Orbit's own rides in the folder's slots (README.md in the folder):
   *
   *   · LOCKUP: the gold world on the ring, with its wake (#1371 note 33911:
   *     the door looks as it does now). It is a second glyph laid over the
   *     door's own in the same grid cell, so it turns about the ring's centre
   *     exactly as it did inside it;
   *   · GATE: whatever the page puts in the way in (`children`: the sign-in's
   *     button, nothing on the launch overlay), and the live status region
   *     under it (#788) that stands where the gate would when the door cannot
   *     open. `.state` is always in the DOM — never conditionally rendered —
   *     because it is an `aria-live="polite"` region: a reader using a screen
   *     reader needs the element to already exist for a later text change to
   *     announce.
   *
   * The ARTWORK is aria-hidden (the folder's markup), not the whole surface:
   * the lockup and the gate ARE the sign-in.
   *
   * The markup is written once, with the words the page starts with, and
   * never rewritten: the folder has mounted itself on it by then. Later
   * words are written into the region in place.
   */
  let {
    children = undefined,
    shown = false,
    /* THE THREE STATES WHERE THE DOOR CANNOT OPEN (#788): fixed Orbit-owned
       text, set by SignIn.svelte, that stands where the gate would */
    statePrimary = "",
    stateSub = "",
    /* THE WORDMARK AS THE PAGE'S HEADING (the folder's `heading` option): true
       writes it as the screen's <h1>; a page that already has its own <h1>
       passes false, so every screen has exactly one. Read once, with the
       markup, which is never rewritten. */
    heading = true,
  } = $props();

  /** @param {string} text */
  const esc = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

  /* the gold world on the ring and its wake, on the glyph's own 200-unit box
     (the ring at r72, the world at 163, 63.5), as the door has always drawn it */
  const lockup = '<div class="glyph orbit-gold" aria-hidden="true"><svg width="420" height="420" viewBox="0 0 200 200">'
    + '<defs><linearGradient id="trail" gradientUnits="userSpaceOnUse" x1="46.5" y1="51.8" x2="163" y2="63.5"><stop offset="0" stop-color="#ffd68c" stop-opacity="0"/><stop offset=".46" stop-color="#ffd68c" stop-opacity=".08"/><stop offset="1" stop-color="#ffdea0" stop-opacity=".75"/></linearGradient></defs>'
    + '<g class="tr"><path d="M46.5 51.8 A72 72 0 0 1 163 63.5" fill="none" stroke="url(#trail)" stroke-width="3.2" stroke-linecap="round"/>'
    + '<image class="gold" href="/flight/door/planet-gold.webp" x="145" y="45.5" width="36" height="36"/></g></svg></div>';

  // svelte-ignore state_referenced_locally
  const markup = dawnMarkup({
    heading,
    image,
    lockup,
    gate: `<div class="state" role="status" aria-live="polite"><div class="state-primary">${esc(statePrimary)}</div><div class="state-sub">${esc(stateSub)}</div></div>`,
  });

  /** @type {HTMLDivElement} */
  let host;
  /** @type {HTMLDivElement} */
  let gateSource;
  /** @type {ReturnType<typeof door.dawn> | null} */
  let dawn = null;
  /** first light asked for before the door was mounted (the page's own onMount may run first)
   * @type {Parameters<ReturnType<typeof door.dawn>["light"]>[0] | null} */
  let lightAsked = null;

  onMount(() => {
    document.documentElement.classList.add("rich");
    /* the page's way in goes into the door's gate, ahead of the status region */
    host.querySelector(".gate-wrap")?.prepend(gateSource);
    dawn = door.dawn(/** @type {HTMLElement} */ (host.querySelector("#door")));
    dawn.start();
    if (lightAsked) dawn.light(lightAsked);
    return () => { dawn?.destroy(); dawn = null; };
  });

  $effect(() => {
    host?.querySelector("#door")?.classList.toggle("shown", shown);
  });

  $effect(() => {
    const primary = host?.querySelector(".state-primary"), sub = host?.querySelector(".state-sub");
    if (primary && primary.textContent !== statePrimary) primary.textContent = statePrimary;
    if (sub && sub.textContent !== stateSub) sub.textContent = stateSub;
  });

  /**
   * First light (the folder's `dawn.light()`, README.md: the dawn), for the
   * page that owns it: the sign-in.
   * @param {Parameters<ReturnType<typeof door.dawn>["light"]>[0]} options
   */
  export function light(options) {
    if (dawn) dawn.light(options); else lightAsked = options;
  }
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- the shared door's own markup (markup.js, pure strings), with Orbit's slots: fixed markup and text escaped here (#1371) -->
<div id="dawn" class:shown bind:this={host}>{@html markup}</div>
<div class="gate-source" bind:this={gateSource}>{@render children?.()}</div>
