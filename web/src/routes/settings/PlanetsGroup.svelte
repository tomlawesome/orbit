<script>
  /*
   * Settings > Your sky > Planets (#1461), ported from round 6's
   * l-sky-settings-preview.html (design/v19/home-sun/round-6, direction L):
   * the "names up close" row (#1461), the "planets sit by" row with its hint
   * (#1462) and, beside them on the desk and above them on the phone, a live
   * sky.   */
  import SkyPreview from "$lib/SkyPreview.svelte";
  import { skyMeasure } from "$lib/sky-measure.js";
  import { labelWords, warningHint } from "$lib/data/sky-words.js";

  /** @type {{ dialect: "desk" | "pocket", household: any, today: string, labelDays: number, skyDriver: "due" | "warning", planetSize: "cost" | "importance", firstWarningDays: ?number, onpreview: (days: number) => void, onpick: (days: number) => void, onpickdriver: (driver: "due" | "warning") => void, onpicksize: (size: "cost" | "importance") => void }} */
  let { dialect, household, today, labelDays, skyDriver, planetSize, firstWarningDays, onpreview, onpick, onpickdriver, onpicksize } = $props();

  /* Both dialects are in the document and CSS shows one: only the one on screen is drawn. */
  const sky = skyMeasure(dialect);
  /** L's words(): 0 is none, the top is every planet. */
  const readout = $derived(labelWords(labelDays));
  const id = $derived(`label-days-${dialect}`);
  const hint = $derived(warningHint(firstWarningDays));
</script>

{#if $sky.shown}
  <h3 class={dialect === "desk" ? "textsize-h" : "p-caps st-textsize"} id="st-planets">Planets</h3>
  {#snippet row()}
    <div class="kv stack"><span>names up close</span>
      <div class="slide"><span class="ends">none</span><input {id} class={dialect === "pocket" ? "days" : ""} type="range" min="0" max="365" step="1" value={labelDays}
          aria-label="Show a planet's name when it is due within this many days" aria-valuetext={readout}
          oninput={(event) => onpreview(Number(event.currentTarget.value))}
          onchange={(event) => onpick(Number(event.currentTarget.value))}><span class="ends">all</span><output for={id}>{readout}</output></div></div>
    <div class="kv stack"><span>planets sit by</span>
      <div class="seg" role="group" aria-label="Planets sit by"><button aria-pressed={skyDriver === "due"} onclick={() => onpickdriver("due")}>due date</button><button aria-pressed={skyDriver === "warning"} onclick={() => onpickdriver("warning")}>my warning date</button></div></div>
    {#if hint}<p class="hint">{hint}</p>{/if}
    <div class="kv stack"><span>planet size shows</span>
      <div class="seg" role="group" aria-label="Planet size shows"><button aria-pressed={planetSize === "cost"} onclick={() => onpicksize("cost")}>cost</button><button aria-pressed={planetSize === "importance"} onclick={() => onpicksize("importance")}>importance</button></div></div>
  {/snippet}
  {#if dialect === "desk"}
    <div class="pl-grid"><div class="rows">{@render row()}</div><div class="preview"><div class="pv"><SkyPreview {household} {today} {labelDays} {skyDriver} {planetSize} {firstWarningDays} {dialect} uid="pvd"/></div></div><p class="pvnote">your sky, as these settings draw it</p></div>
  {:else}
    <div class="phone-planets"><div class="preview"><div class="pv"><SkyPreview {household} {today} {labelDays} {skyDriver} {planetSize} {firstWarningDays} {dialect} uid="pvp"/></div></div>{@render row()}</div>
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
  .phone-planets .preview{margin:0 calc(var(--p-card-pad) * -1) 8px;border:0;border-radius:0;background:none}
  .phone-planets .preview .pv{transform:none;height:auto;width:100%;max-width:390px}
  .phone-planets .preview .pv :global(svg){width:100%;height:auto}
  .phone-planets .slide{max-width:none;flex-wrap:wrap}
  .phone-planets .slide input{max-width:none}
  .slide .days{min-height:var(--p-hit)}
  /* L's segment and hint; its --ink-2 is --ink-mid, --ink-3 is --ink-faint, the pressed fill is --accent-text (as Tiles has it: --accent fails AA in the light packs), and sizes are rem. */
  .seg{display:inline-flex;border:1px solid var(--line);border-radius:99px;overflow:hidden;background:var(--panel)}
  .seg button{min-height:var(--p-hit);padding:0 13px;border:0;background:none;color:var(--ink-mid);font:0.71875rem var(--mono);cursor:pointer;border-left:1px solid var(--line)}
  .seg button:first-child{border-left:0}
  .seg button[aria-pressed=true]{background:var(--accent-text);color:var(--bg)}
  .kv.stack .seg{display:flex}
  .kv.stack .seg button{flex:1}
  .hint{font:0.6875rem var(--mono);color:var(--ink-faint);margin:6px 0 8px;line-height:1.45}
  /* L's desk size; the phone keeps the tap floor above (SMALL_RULE_OVERRIDDEN in pocket-tap-floor-lib.mjs). */
  .pl-grid .seg button{min-height:30px}
  .phone-planets .seg button{font-size:0.78125rem;padding:0 16px}
  .phone-planets .slide output{flex-basis:100%;text-align:left;margin-top:-6px}
</style>
