<script>
  import Calendar from "./Calendar.svelte";
  import Tiles from "./Tiles.svelte";
  import RepeatBand from "./RepeatBand.svelte";

  /**
   * THE CHOOSER CARD (#1319; owner-decisions §34; design/v19/belt-purpose/
   * round-8/m-colour-per-option.html, scenes `editing-date`,
   * `editing-section`, `editing-type`, `editing-period` and
   * `narrow-editing-section`; rounds 4-7 for the calendar, the tiles and
   * the band). While an item is edited in its drawer, pressing the due
   * date, the section, the type or the period stands this card beside the
   * drawer, in the column the document preview stands in on desk, or as
   * the bottom sheet under 1200px.
   *
   * The card is the reading card's twin and draws only itself: the glass
   * edged in the accent (the item card's open outline), its head (the
   * value's name, and close · esc) and its body. Where it stands is the
   * screen's: `layout` says which surface to wear ("beside" is the 356px
   * card; "sheet" the full-width sheet with its grab and square foot), and
   * the screen seats it in the column or fixes it to the foot.
   *
   * The body is the value's own chooser:
   *   · "due", "snooze", "done": the month calendar (Calendar.svelte);
   *   · "section", "type": the tiles, each in its colour (Tiles.svelte);
   *   · "months": the period band stood up (RepeatBand.svelte).
   *
   * A day, tile or cell pressed (or Enter/Space on it) hands its value to
   * `onpick`: a `YYYY-MM-DD` date, a section id, a type, or the period's
   * months as a string. Esc, anywhere while the card stands, calls
   * `onclose` before anything else hears it, so an open chooser takes Esc
   * before the edit does (the mockup's rule); the screen puts focus back on
   * the pressed value (EditSession.closeChooser). Focus lands on the chosen
   * value as the card opens, or on today's date when none is chosen.
   *
   * Not a modal: the drawer stays live beside it, so the card is a
   * non-modal dialog (the pressed value carries aria-haspopup="dialog").
   *
   * @typedef {{
   *   ask: import('./item-draft.js').ChooserAsk,
   *   layout: "beside" | "sheet",
   *   onpick: (value: string) => void,
   *   onclose: () => void,
   * }} Props
   */
  /** @type {Props} */
  let { ask, layout, onpick, onclose } = $props();

  const CALENDAR = ["due", "snooze", "done"];
  /** What the body is for; a new one repaints it and moves focus into it. */
  const asked = $derived(`${ask.key}:${ask.value ?? ""}`);
  const kind = $derived(CALENDAR.includes(ask.key) ? "calendar" : ask.key === "months" ? "band" : "tiles");

  /** @type {HTMLDivElement | undefined} */
  let body = $state();

  /* focus moves in the frame the card is seen: a sheet the screen slides
     up is not focusable until then (the mockup's focusCurrent) */
  $effect(() => {
    void asked;
    const frame = requestAnimationFrame(() => {
      /** @type {HTMLElement | null | undefined} */
      const rest = body?.querySelector('[tabindex="0"]');
      rest?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  });

  /** @param {KeyboardEvent} event */
  function escape(event) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onclose();
  }
</script>

<svelte:window onkeydowncapture={escape} />

<div class="chooser" class:sheet={layout === "sheet"} role="dialog" aria-label={`Choose ${ask.heading}`}>
  <div class="head">
    <h3>{ask.heading}</h3>
    <button type="button" class="close" onclick={onclose}>close<span class="kb">&nbsp;· esc</span></button>
  </div>
  <div class="body" bind:this={body}>
    {#key asked}
      {#if kind === "calendar"}
        <Calendar value={ask.value} today={ask.today} {onpick} />
      {:else if kind === "band"}
        <RepeatBand choices={ask.choices} value={ask.value} label={ask.label} {onpick} />
      {:else}
        <Tiles choices={ask.choices} value={ask.value} label={ask.label} cols={ask.key === "type" ? 3 : 2} {onpick} />
      {/if}
    {/key}
  </div>
</div>

<style>
  /* the reading card's glass, wearing the item card's open outline (round 5);
     356px wide: 320px inside for seven 45px days */
  .chooser{box-sizing:border-box;width:356px;max-width:100%;padding:10px 18px 14px;
           background:var(--panel-raised);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
           border:1px solid var(--accent);border-radius:18px;color:var(--ink);
           animation:beside .55s cubic-bezier(.4,.5,.15,1) both}
  .chooser :global(*){box-sizing:border-box}
  .head{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:44px;margin:-12px -8px -6px}
  /* tracked caps: the floor, 12px (pocket/tokens.css) */
  h3{margin:0;font:var(--p-type-caps) var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
     color:var(--ink-faint);font-weight:400}
  .close{flex:none;height:44px;padding:0 10px;margin-right:-2px;border:0;border-radius:999px;background:none;cursor:pointer;
         font:var(--p-type-caps) var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mid)}
  .close:hover{color:var(--ink)}
  .close:focus-visible{outline:none;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--accent)}
  .kb{color:var(--ink-faint)}

  /* under 1200px: the phone's bottom sheet (CON-10) — full width, 18px
     shoulders, the grab, no sides or foot; the screen fixes it to the foot */
  .sheet{width:auto;max-width:none;max-height:88vh;overflow:auto;border-width:1px 0 0;border-radius:18px 18px 0 0;
         padding:10px 14px max(12px, env(safe-area-inset-bottom));backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
         animation:rise .3s cubic-bezier(.3,.7,.3,1) both}
  .sheet::before{content:"";display:block;width:36px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 4px}
  .sheet .head{margin:-6px -6px -6px}
  .sheet .kb{display:none}

  @keyframes beside{from{opacity:0;transform:translateX(-16px)}}
  @keyframes rise{from{transform:translateY(105%)}}
  @media (prefers-reduced-motion: reduce){
    .chooser,.sheet{animation:none}
  }
</style>
