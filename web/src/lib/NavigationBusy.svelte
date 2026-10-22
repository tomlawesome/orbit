<script>
  import { navigating } from "$app/state";
  import { portal } from "$lib/pocket/portal.js";

  /**
   * Says that a screen the reader asked for is on its way (#1465). A click
   * on a link whose page needs its server data first leaves the old screen
   * standing until that data arrives, with nothing to show the click was
   * heard. Mounted once, in the root layout, like the wake.
   *
   * It only speaks for the screens named in WAITS, and only once the wait
   * has lasted longer than a quick page turn, so a fast arrival never
   * flashes it. The drawn pill is absent when nothing is loading; the live region
   * that announces it stays on the page, empty.
   */
  /** The routes that say so, and the name the line gives them. */
  const WAITS = /** @type {Record<string, string>} */ ({ "/about": "About" });
  /** A wait shorter than this is a page turn, not a wait. */
  const SHOW_AFTER_MS = 150;

  const target = $derived(navigating.to?.route.id ?? null);
  const name = $derived(target !== null ? (WAITS[target] ?? null) : null);

  let shownFor = $state(/** @type {string | null} */ (null));
  $effect(() => {
    if (name === null) {
      shownFor = null;
      return;
    }
    const timer = setTimeout(() => (shownFor = name), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  });
</script>

<!-- The announcement goes INTO a region that was already on the page, empty
     (Wake.svelte does the same): a region that arrives with its words is
     often not announced. The pill is only the drawn copy of it. -->
<div class="sr-only nav-busy-region" role="status" aria-live="polite" data-pocket-above use:portal>{shownFor !== null ? `Loading ${shownFor}…` : ""}</div>
{#if shownFor !== null}
  <div class="nav-busy" aria-hidden="true" data-pocket-above use:portal>
    <span class="dot"></span>Loading {shownFor}…
  </div>
{/if}

<style>
  /* Pinned, not left absolute at the end of <body>: there its 1px box sat
     below a page that exactly fills the screen and made it scroll (the
     invite outcome, invite-desk-margin.spec.js). Wake's regions sit in a
     fixed host for the same reason. */
  .nav-busy-region{position:fixed;top:0;left:0}
  .nav-busy{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);
    z-index:60;pointer-events:none;display:flex;align-items:center;gap:10px;
    padding:8px 16px;border-radius:999px;background:var(--panel-raised);
    border:1px solid var(--line);color:var(--ink);font:500 .875rem/1.4 var(--ui);
    box-shadow:0 8px 24px rgb(0 0 0 / .25);animation:nav-busy-breathe 1.6s ease-in-out infinite}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
  @keyframes nav-busy-breathe{0%,100%{opacity:1}50%{opacity:.6}}
  @media (prefers-reduced-motion:reduce){ .nav-busy{animation:none} }
</style>
