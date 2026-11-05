<script>
  /*
   * Settings > Your sky > Planets (#1461), ported from round 6's
   * l-sky-settings-preview.html (design/v19/home-sun/round-6, direction L):
   * the "names up close" row and, beside it on the desk and above it on the
   * phone, a live sky. Only this row is built; "planets sit by" and "planet
   * size shows" come with #1462 and #1463.
   */
  import SkyPreview from "$lib/SkyPreview.svelte";
  import { skyMeasure } from "$lib/sky-measure.js";

  /** @type {{ dialect: "desk" | "pocket", household: any, today: string, labelDays: number, onpreview: (days: number) => void, onpick: (days: number) => void }} */
  let { dialect, household, today, labelDays, onpreview, onpick } = $props();

  /* Both dialects are in the document and CSS shows one: only the one on screen is drawn. */
  const sky = skyMeasure(dialect);
  /** L's words(): 0 is none, the top is every planet. */
  const words = (/** @type {number} */ d) => (d <= 0 ? "none" : d >= 365 ? "every planet" : d === 1 ? "within 1 day" : `within ${d} days`);
  const readout = $derived(words(labelDays));
  const id = $derived(`label-days-${dialect}`);
</script>

{#if $sky.shown}
  <h3 class={dialect === "desk" ? "textsize-h" : "p-caps st-textsize"} id="st-planets">Planets</h3>
  {#snippet row()}
    <div class="kv stack"><span>names up close</span>
      <div class="slide"><span class="ends">none</span><input {id} class={dialect === "pocket" ? "days" : ""} type="range" min="0" max="365" step="1" value={labelDays}
          aria-label="Show a planet's name when it is due within this many days" aria-valuetext={readout}
          oninput={(event) => onpreview(Number(event.currentTarget.value))}
          onchange={(event) => onpick(Number(event.currentTarget.value))}><span class="ends">all</span><output for={id}>{readout}</output></div></div>
  {/snippet}
  {#if dialect === "desk"}
    <div class="pl-grid"><div class="rows">{@render row()}</div><div class="preview"><div class="pv"><SkyPreview {household} {today} {labelDays} {dialect} uid="pvd"/></div></div><p class="pvnote">your sky, as these settings draw it</p></div>
  {:else}
    <div class="phone-planets"><div class="preview"><div class="pv"><SkyPreview {household} {today} {labelDays} {dialect} uid="pvp"/></div></div>{@render row()}</div>
  {/if}
{/if}

<style>
  /* L's rules, in the app's tokens (L's --ink-2 is --ink-mid, --ink-3 is --ink-faint) and rem, so the text-size step reaches them. */
  .kv.stack{display:flex;flex-direction:column;align-items:stretch;gap:8px;justify-content:space-between;font:0.71875rem var(--mono);color:var(--ink-mid);padding:12px 0;border-bottom:1px solid var(--line-soft)}
  .kv.stack:last-child{border:0}
  .kv.stack>span:first-child{flex:none;font:0.75rem var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-quiet)}
  .slide{display:flex;align-items:center;gap:12px;flex:1;justify-content:flex-end;max-width:420px}
  .slide input{flex:1;accent-color:var(--accent);margin:0;max-width:260px}
  .slide output{font:0.75rem var(--mono);color:var(--ink);min-width:86px;text-align:right}
  .slide .ends{font:0.65625rem var(--mono);color:var(--ink-faint)}
  .preview{display:flex;justify-content:center;margin:6px 0 4px;border:1px solid var(--line-soft);border-radius:12px;background:var(--panel)}
  .preview .pv{transform:scale(.8);transform-origin:top center;height:300px}
  .pvnote{font:0.6875rem var(--mono);color:var(--ink-faint);text-align:center;margin:0 0 6px}
  .pl-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:0 20px;align-items:start}
  .pl-grid .rows{min-width:0}
  .pl-grid .preview{margin:0;grid-row:1 / span 2}
  .pl-grid .preview .pv{transform:scale(.74);height:276px;width:390px;transform-origin:top center;margin:0 -45px}
  .pl-grid .pvnote{grid-column:2}
  .pl-grid .slide{max-width:none;flex-wrap:wrap}
  .pl-grid .slide input{max-width:none}
  .pl-grid .slide output{flex-basis:100%;text-align:left;margin-top:-4px}
  .pl-grid .kv.stack{padding:10px 0}
  /* the phone: the preview above the rows, bled to the column's edges */
  .phone-planets .preview{margin:0 0 8px;border:0;border-radius:0;background:none}
  .phone-planets .preview .pv{transform:none;height:auto;width:100%;max-width:390px}
  .phone-planets .preview .pv :global(svg){width:100%;height:auto}
  .phone-planets .slide{max-width:none;flex-wrap:wrap}
  .phone-planets .slide input{max-width:none}
  .slide .days{min-height:var(--p-hit)}
  .phone-planets .slide output{flex-basis:100%;text-align:left;margin-top:-6px}
</style>
