<script>
  /**
   * A household closed for a moment (#1316, owner 2026-10-14): one of its
   * owners is bringing an archive in, and until that finishes nobody else may
   * see or change anything in it. Drawn by the four household views (home and
   * the household's own screen, desk and pocket) in place of their content;
   * each keeps its chrome and its own ways to the reader's other households.
   *
   * No time, no count, no mechanics: nothing says when the import ends, so
   * the words only say to come back later. The notice is not live-updated;
   * a reload or a navigation after the import draws the household whole.
   *
   * The way home is a kit pill, so on a phone it is at least --p-hit tall.
   */
  import { resolve } from "$app/paths";

  /** @type {{ name: string, hasOthers?: boolean, showHomeLink?: boolean }} */
  let { name, hasOthers = false, showHomeLink = false } = $props();
</script>

<section class="closed">
  <h2>{name} is closed for a moment</h2>
  <p>Its owner is bringing an archive in. Nothing here can be seen or changed until that finishes — please come back later.</p>
  {#if hasOthers}<p>Your other households are open as usual.</p>{/if}
  {#if showHomeLink}<a class="p-pill home" href={resolve("/home")}>back to home</a>{/if}
</section>

<style>
  .closed{position:relative;z-index:2;box-sizing:border-box;max-width:440px;margin:32px auto;
    padding:24px 26px;text-align:center;border:1px solid var(--line);border-radius:16px;
    background:var(--panel-raised, var(--panel));overflow-wrap:anywhere}
  .closed h2{margin:0;font:600 20px/1.3 var(--display);color:var(--ink)}
  .closed p{margin:12px 0 0;font:11.5px/1.9 var(--mono);color:var(--ink-mid);letter-spacing:.03em}
  .closed .home{margin-top:20px}
</style>
