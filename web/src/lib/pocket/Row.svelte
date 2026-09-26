<script>
  import { dev } from "$app/environment";
  import ArmButton from "./ArmButton.svelte";
  import { mountRow } from "./row.js";
  /* First, with no comment of its own: Svelte hoists $props.id() and would
     carry a leading doc comment into the compiled declaration (#1120). */
  const uid = $props.id();

  /**
   * THE ROW (#1120, proposal §1.5; review round §1.1): one line of any
   * pocket list.
   *
   *   ●  Title in 16px ui, one line, ellipsis          T-16d
   *      meta in 13px, wraps                          29 Aug
   *   24px mark column · 12px gap · 56px min height · 16px side padding
   *
   * A row does one of three things with a tap on its face, never two:
   *   href        it navigates (a link)
   *   onactivate  it summons a sheet (a button)
   *   acts/detail it opens in place (row.js): the face grows a panel under
   *               it holding the `detail` snippet (.p-kv lines, kit.css),
   *               then the acts as pills, primary first and danger last,
   *               then the `after` snippet (a quiet link line). Where a row
   *               that opens also leads somewhere, the way onward is an
   *               act with `href` (`open →`), never the face.
   * Passing `href` or `onactivate` with acts or detail is a dev-time error.
   *
   * An act runs and then the row closes. A `danger` act arms on its first
   * tap, the row staying open, fires on its second, then the row closes.
   * Every act's `name` is its full accessible name, object included:
   * { label: "remove", name: "Remove Emma Lawson", onact, danger: true }.
   * An act's `tone` colours its pill the desk way (ok complete, up
   * reschedule, warm snooze, accent edit or open); danger is the red one.
   *
   * With `onmove`, Alt-↑/↓ on the face moves the row; the pills that do the
   * same (`move up`, `move down`) are acts the screen passes, and the long
   * press is the list's (reorder.js, `use:mountReorder` on the list).
   *
   * `bead` draws the trail as an accent count bead (the inbox waiting);
   * `trailName` is what a screen reader hears instead of the drawn trail.
   *
   * `end` draws a control in the trailing column instead of a value (the
   * household's section switch). It sits in the face, beside the button
   * that opens the row, so its own tap never opens the row.
   *
   * `meta` speaks mono, the desk's face for data (section · amount, date,
   * role). Set `metaFace="ui"` wherever the meta is a sentence or
   * descriptive prose (a failure's reason, a status in words): it then
   * reads in the body face, untracked, as kit.css's `.p-prose` (§5.2).
   *
   * `below` draws a line under the row that is always there, not behind a
   * tap (a knock's approve and decline, which are the point of the row).
   *
   * `ontoggle` hears the row open and close (home reads an item's papers
   * when its row first opens); `key` is written as data-row-key, so a
   * screen can find the row for a record and open it (row.js rowOf).
   * @typedef {{
   *   title: string,
   *   meta?: string,
   *   metaFace?: "mono" | "ui",
   *   trail?: string,
   *   trailSub?: string,
   *   trailTone?: string,
   *   trailName?: string,
   *   bead?: boolean,
   *   href?: string,
   *   onactivate?: () => void,
   *   current?: boolean,
   *   acts?: import("./row.js").RowAct[],
   *   onmove?: (direction: -1 | 1) => void,
   *   mark?: import('svelte').Snippet,
   *   end?: import('svelte').Snippet,
   *   detail?: import('svelte').Snippet,
   *   after?: import('svelte').Snippet,
   *   below?: import('svelte').Snippet,
   *   ontoggle?: (open: boolean) => void,
   *   key?: string,
   * }} Props
   */
  /** @type {Props} */
  let {
    title,
    meta = "",
    metaFace = "mono",
    trail = "",
    trailSub = "",
    trailTone = "",
    trailName = "",
    bead = false,
    href = undefined,
    onactivate = undefined,
    current = false,
    acts = [],
    onmove = undefined,
    mark = undefined,
    end = undefined,
    detail = undefined,
    after = undefined,
    below = undefined,
    ontoggle = undefined,
    key = undefined,
  } = $props();

  const opens = $derived(acts.length > 0 || Boolean(detail));
  $effect(() => {
    if (dev && opens && (href || onactivate))
      throw new Error(`Row "${title}": a row that opens (acts, detail) cannot also navigate or summon (href, onactivate)`);
  });

  /** @type {HTMLElement | undefined} */
  let row = $state();
  /** @type {ReturnType<typeof mountRow> | undefined} */
  let control;
  $effect(() => {
    if (!row || !opens) return;
    control = mountRow(row, { onchange: (open) => ontoggle?.(open) });
    return () => control?.destroy();
  });

  /** @param {import("./row.js").RowAct} act */
  async function run(act) {
    await act.onact?.();
    control?.close(true);
  }

  /** @param {KeyboardEvent} event */
  function onkeydown(event) {
    if (!onmove || !event.altKey) return;
    if (event.key === "ArrowUp") { event.preventDefault(); onmove(-1); }
    else if (event.key === "ArrowDown") { event.preventDefault(); onmove(1); }
  }
  /** @param {import("./row.js").RowAct} act */
  const tone = (act) => (act.tone === "filled" ? "filled" : act.tone ? `act-${act.tone}` : "");
  const tag = $derived(href ? "a" : opens || onactivate ? "button" : "div");
</script>

<div class="p-row" class:current class:opens data-row data-row-key={key} bind:this={row}>
  <div class="face">
    <!-- One face whatever the row does: a link when it navigates, a button
         when it summons a sheet or opens in place, else inert. A dynamic
         element rather than three branches sharing a snippet: a snippet
         here is hoisted by the compiler and drags the script's doc comments
         into a declaration the production bundler cannot parse. -->
    <!-- The key handler only ever acts on a row with `onmove`, and every
         row that moves opens, so its face is a button then. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svelte:element this={tag} class="hit" data-row-face
        href={href || undefined}
        type={tag === "button" ? "button" : undefined}
        aria-current={href && current ? "page" : undefined}
        aria-expanded={opens ? "false" : undefined}
        aria-controls={opens ? `${uid}-panel` : undefined}
        aria-keyshortcuts={onmove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onclick={opens ? undefined : onactivate}
        {onkeydown}>
      <span class="mark" aria-hidden="true">{@render mark?.()}</span>
      <span class="text">
        <span class="title">{title}</span>
        {#if meta}<span class="meta" class:ui={metaFace === "ui"}>{meta}</span>{/if}
      </span>
      {#if trail || trailSub}
        <span class="trail" class:bead style:color={trailTone || undefined}><span aria-hidden={trailName ? "true" : undefined}>{trail}</span>{#if trailName}<span class="sr-only">{trailName}</span>{/if}{#if trailSub}<small>{trailSub}</small>{/if}</span>
      {/if}
    </svelte:element>
    {#if end}<span class="end">{@render end()}</span>{/if}
  </div>
  {#if opens}
    <div class="unfold">
      <!-- `hidden` until opened (row.js), so its pills are in the Tab order
           only while it shows. -->
      <div class="p-row-open" id="{uid}-panel" data-row-panel hidden>
        <div class="p-row-in">
          {@render detail?.()}
          {#if acts.length}
            <div class="p-pills" data-row-acts>
              {#each acts as act (act.name)}
                {#if act.href}
                  <!-- The screen resolves the act's address; this only draws it. -->
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                  <a class="p-pill {tone(act)}" href={act.href} aria-label={act.name}
                     onclick={() => act.onact?.()}>{act.label}</a>
                {:else if act.danger || act.arms}
                  <ArmButton label={act.label} name={act.name} danger={Boolean(act.danger)} class={tone(act)}
                             onfire={() => run(act)} />
                {:else}
                  <button class="p-pill {tone(act)}" aria-label={act.name} onclick={() => run(act)}>{act.label}</button>
                {/if}
              {/each}
            </div>
          {/if}
          {@render after?.()}
        </div>
      </div>
    </div>
  {/if}
</div>
{#if below}<div class="p-row-below">{@render below()}</div>{/if}

<style>
  /* clip, not hidden: the open row's corners are its own, and clip never
     makes a scroller. */
  .p-row{position:relative;overflow:clip;border-radius:12px}
  .face{position:relative;z-index:1;display:flex;align-items:stretch;
    min-height:var(--p-row-min);box-sizing:border-box;border-radius:12px;
    background:transparent;transition:background-color 120ms}
  .hit{flex:1;min-width:0;display:flex;align-items:center;gap:var(--p-row-gap);box-sizing:border-box;
    min-height:var(--p-row-min);margin:0;padding:6px var(--p-gutter);border:0;border-radius:inherit;
    background:none;color:var(--ink);font:inherit;text-align:left;text-decoration:none;
    -webkit-tap-highlight-color:transparent}
  .face:has(> .end) > .hit{padding-right:0}
  a.hit,button.hit{cursor:pointer}
  .face:has(> :is(a, button).hit:active){background:var(--panel-raised)}
  .hit:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .mark{flex:none;width:var(--p-row-mark);display:grid;place-items:center;color:var(--ink-mid)}
  .mark:empty{display:none}
  .text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .title{font:500 var(--p-type-body)/1.3 var(--ui);color:var(--ink);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .current .title{color:var(--accent-text)}
  .meta{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .meta.ui{font:var(--p-type-meta)/1.5 var(--ui);letter-spacing:normal}
  .trail{flex:none;text-align:right;font:500 var(--p-type-meta)/1.3 var(--mono);color:var(--ink-mid)}
  .trail.bead{min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;border-radius:11px;
    display:grid;place-items:center;background:var(--accent);color:var(--bg);font-weight:600}
  :global([data-theme=retrograde]) .trail.bead{box-shadow:0 0 9px var(--bloom)}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .trail.bead{color:#fff}
  .trail small{display:block;font-size:var(--p-type-meta);color:var(--ink-quiet);font-weight:400}
  .end{flex:none;display:flex;align-items:center;padding:0 var(--p-gutter) 0 var(--p-row-gap)}

  /* ON THE CARD'S GLASS (§5.2): the face is transparent at rest, so a row
     is a line on its card, not a strip one tone darker. Rows after the
     first draw a hairline from the text edge, so the mark column reads as
     a rail, as the desk's members list does. An open row's panel draws
     none below it: the next row's own hairline does that job. */
  :global(:is(.p-row, .p-row-below)) + .p-row > .face::before{content:"";position:absolute;top:0;right:0;
    left:calc(var(--p-gutter) + var(--p-row-mark) + var(--p-row-gap));border-top:1px solid var(--line-soft)}
  :global(:is(.p-row, .p-row-below)) + .p-row > .face:has(.mark:empty)::before{left:var(--p-gutter)}

  /* OPEN (review round §1.1): the raised plane, with the accent rail down
     its leading edge, the face's bottom corners handed to the panel. The
     trail and meta stay. The attribute is :global because row.js sets it. */
  .p-row:global([data-open]) > .face{background:var(--panel-raised);box-shadow:inset 2px 0 0 var(--accent);
    border-radius:12px 12px 0 0}

  /* The unfold: the desk's ivopen (home.css), verbatim. The panel's rows
     grow 0fr → 1fr over 200ms; its content arrives from 6px up over 300ms.
     Close is the reverse at 200ms. */
  .unfold{display:grid;grid-template-rows:0fr;transition:grid-template-rows 200ms var(--p-ease)}
  .p-row:global([data-open]) > .unfold{grid-template-rows:1fr}
  .p-row-open{min-height:0;overflow:hidden}
  .p-row-in{opacity:0;transform:translateY(-6px);
    transition:opacity 200ms cubic-bezier(.2,.7,.2,1),transform 200ms cubic-bezier(.2,.7,.2,1)}
  .p-row:global([data-open]) .p-row-in{opacity:1;transform:none;transition-duration:300ms}

  /* Long-press lift (reorder.js). */
  .p-row:global([data-lifted]){z-index:3;overflow:visible;box-shadow:0 10px 28px rgb(0 0 0 / .35);
    transition:none}
  /* Picked up off the glass. */
  .p-row:global([data-lifted]) > .face{background:linear-gradient(var(--panel-raised), var(--panel-raised)), var(--bg)}
  :global([data-reordering]) .face{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
  .p-row-below{display:flex;flex-wrap:wrap;gap:var(--p-pill-gap);padding:0 var(--p-gutter) 12px
    calc(var(--p-gutter) + var(--p-row-mark) + var(--p-row-gap))}
  .p-row-below > :global(*){flex:1 1 40%}
  /* Reduced motion: the panel appears and goes. */
  @media (prefers-reduced-motion:reduce){ .unfold,.p-row-in{transition:none} }
</style>
