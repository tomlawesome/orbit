<script>
  import { chromeHidden } from "./gesture.js";

  /**
   * THE POCKET'S TOP CHROME (#1120, proposal §1.3): 56px plus the top safe
   * area. The way back on the left (13px mono caps with the desk's star-field
   * halo, 44px hit), or the wordmark on home; whatever `end` draws on the
   * right (the orb). It scrolls away as the page goes down and comes back on
   * any scroll up, as a glass strip over the sky; at the top of the page it is
   * bare, like the desk's.
   *
   * `back` must already be a resolved path.
   * @type {{
   *   back?: string,
   *   backLabel?: string,
   *   wordmark?: boolean,
   *   end?: import('svelte').Snippet,
   * }}
   */
  let { back = undefined, backLabel = "← your sky", wordmark = false, end = undefined } = $props();

  let hidden = $state(false);
  let scrolled = $state(false);
  /** @type {HTMLElement | undefined} */
  let bar = $state();

  $effect(() => {
    let lastY = scrollY;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = scrollY;
        hidden = chromeHidden({ y, lastY, hidden, height: bar?.offsetHeight ?? 56 });
        scrolled = y > 0;
        lastY = y;
      });
    };
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  });
</script>

<!-- Focus inside a retracted bar brings it back: a keyboard reader must
     never Tab onto a control they cannot see. -->
<header class="p-chrome" class:hidden class:scrolled bind:this={bar} onfocusin={() => (hidden = false)}>
  {#if wordmark}
    <span class="wordmark"><svg width="22" height="22" viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="72" fill="none" stroke="var(--ink-mid)" stroke-width="10"/><circle cx="163" cy="63.5" r="22" style="fill:var(--accent)"/></svg> orbit</span>
  {:else if back}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a class="back" href={back}>{backLabel}</a>
  {/if}
  <span class="end">{@render end?.()}</span>
</header>

<style>
  .p-chrome{position:fixed;top:0;left:0;right:0;z-index:20;box-sizing:border-box;
    height:calc(var(--p-chrome) + env(safe-area-inset-top));
    padding:env(safe-area-inset-top) calc(var(--p-gutter) - 8px) 0;
    display:flex;align-items:center;justify-content:space-between;
    border-bottom:1px solid transparent;
    transition:transform var(--p-spring) var(--p-ease),background-color var(--p-spring),border-color var(--p-spring)}
  .p-chrome.scrolled{background:color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter:blur(16px);border-bottom-color:var(--line-soft)}
  .p-chrome.hidden{transform:translateY(-100%)}
  .back{display:inline-flex;align-items:center;min-height:var(--p-hit);padding:0 8px;
    font:var(--p-type-meta)/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;
    color:var(--ink-quiet);text-decoration:none;
    text-shadow:0 0 2px var(--bg),0 0 5px var(--bg),0 0 11px var(--bg)}
  .back:hover{color:var(--accent-text)}
  .back:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}
  .wordmark{display:flex;align-items:center;gap:10px;padding:0 8px;font:600 17px var(--display);
    letter-spacing:.02em;color:var(--ink)}
  .end{display:flex;align-items:center}
  @media (prefers-reduced-motion:reduce){ .p-chrome{transition:none} }
</style>
