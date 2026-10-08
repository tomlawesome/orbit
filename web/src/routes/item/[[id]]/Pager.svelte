<script>
  import { tick } from "svelte";
  import { pageTurn } from "$lib/data/page-turn.js";

  /**
   * THE PREVIEW'S PAGER (#1300; design/v19/document-card/round-6's `.pager`,
   * verbatim in markup and CSS). Under the preview's page, on the desk's
   * reading card and the phone's sheet alike: `1 of 3`, with `←` and `→`
   * either side, each shown only when there is a page that way. A hidden
   * arrow keeps its place (`.none`, out of the tab order and the tree) so
   * the number never shifts. A one-page file says "one page" and has no
   * arrows; until a response has said how many pages there are, the row
   * says nothing.
   *
   * `onturn` is handed the page asked for; the item screen fetches it and
   * hands back `page`. When an arrow goes at an end and had focus, focus
   * moves to the other, as the reader's do.
   *
   * @typedef {{
   *   page: number,
   *   count: number | null,
   *   onturn: (page: number) => void,
   * }} Props
   */
  /** @type {Props} */
  let { page, count, onturn } = $props();

  const turn = $derived(pageTurn(page, count));
  /** @type {HTMLButtonElement | undefined} */
  let prev = $state();
  /** @type {HTMLButtonElement | undefined} */
  let next = $state();

  /** @param {number} target */
  function go(target) {
    const from = document.activeElement;
    onturn(target);
    tick().then(() => {
      if (from === next && !turn.forward) prev?.focus({ preventScroll: true });
      else if (from === prev && !turn.back) next?.focus({ preventScroll: true });
    });
  }
</script>

<div class="pager">
  {#if turn.arrows}
    <button type="button" class="pg" class:none={!turn.back} bind:this={prev} aria-label="Previous page"
            title="← or PageUp" tabindex={turn.back ? undefined : -1} aria-hidden={turn.back ? undefined : "true"}
            onclick={() => go(page - 1)}>←</button>
  {/if}
  <span class="pgn" aria-live="polite">{#if turn.arrows}<span class="sr-only">page</span>{/if}{turn.arrows ? " " : ""}{turn.of}</span>
  {#if turn.arrows}
    <button type="button" class="pg" class:none={!turn.forward} bind:this={next} aria-label="Next page"
            title="→ or PageDown" tabindex={turn.forward ? undefined : -1} aria-hidden={turn.forward ? undefined : "true"}
            onclick={() => go(page + 1)}>→</button>
  {/if}
</div>

<style>
  .pager{display:flex;justify-content:center;align-items:center;gap:6px;min-height:44px;
         font:11px var(--mono);color:var(--ink-mid);letter-spacing:.02em}
  .pg{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;
      font:14px var(--mono);color:var(--ink-mid);background:none;border:0;border-radius:999px;cursor:pointer}
  .pg:hover{color:var(--ink)}
  .pg:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .pgn{color:var(--ink);font-variant-numeric:tabular-nums;min-width:52px;text-align:center}
  .pg.none{visibility:hidden}
  /* on a phone the count meets the pocket's text floor, at its meta size
     like the band's captions (belt.css; the query is media.js's POCKET_QUERY) */
  @media (max-width:900px), (max-height:600px){
    .pager{font-size:var(--p-type-meta)}
  }
</style>
