<script>
  import ArmButton from "./ArmButton.svelte";
  const uid = $props.id();

  /**
   * A PIECE OF MAIL FOR YOUR REVIEW (#1120, proposal §2.6; round 3 §4,
   * #1140): the inbox's review card, beside the review sheet
   * (ReviewSheet.svelte) the inbox raises in place. (The receipt page,
   * `/item/<receiptId>`, retired with the belt, #1319.)
   *
   * The dashed pen of "not yet in orbit", then: the title (18px), `caught
   * 11 Aug · burns up in 43d`, the readings as `.p-kv` lines with `sure` or
   * `unsure`, the attachment line (`◆ name · scanned clean`) -- a button
   * that opens the page (#1155) -- `Add to orbit` (filled, arms) and
   * `Dismiss` (danger, arms) full width, then `review & amend →`, then
   * whatever `after` draws (the receipt page's quiet way home). Locked
   * (#941): nothing to add until an administrator restores the key, so the
   * way in is shown, and shut.
   *
   * It draws; the screen acts. `busy` names the act in flight.
   * @typedef {{ label: string, value: string, sure: boolean | null, field: string }} Reading
   * @typedef {{
   *   title: string,
   *   caught: string,
   *   burnsIn?: number | null,
   *   readings?: Reading[],
   *   papers?: { id: string | null, name: string, drawable: boolean }[],
   *   unreadable?: string | null,
   *   locked?: boolean,
   *   busy?: "approve" | "dismiss" | null,
   *   problem?: string | null,
   *   heading?: 1 | 2 | 3,
   *   index?: number,
   *   onapprove: () => unknown,
   *   ondismiss: () => unknown,
   *   onamend: () => unknown,
   *   onpaper?: (paper: { id: string | null, name: string, drawable: boolean }) => void,
   *   after?: import('svelte').Snippet,
   * }} Props
   */
  /** @type {Props} */
  let {
    title, caught, burnsIn = null, readings = [], papers = [], unreadable = null, locked = false,
    busy = null, problem = null, heading = 3, index = 0, onapprove, ondismiss, onamend, onpaper = undefined,
    after = undefined,
  } = $props();
</script>

<article class="p-card proposed p-review" style:--i={index} aria-labelledby="{uid}-title">
  <div class="rv-head">
    <span class="rv-touch" aria-hidden="true"><span class="p-body sug"></span></span>
    <div class="rv-words">
      <svelte:element this={`h${heading}`} class="rv-title" id="{uid}-title">{title}</svelte:element>
      <p class="rv-when">caught {caught}{#if burnsIn !== null}&nbsp;· <span class:soon={burnsIn < 14}>burns up in {burnsIn}d</span>{/if}</p>
    </div>
  </div>

  {#if readings.length}
    <dl class="rv-reads">
      {#each readings as reading (reading.field)}
        <div class="p-kv">
          <dt>{reading.label}</dt>
          <dd><b>{reading.value}</b>{#if reading.sure !== null}<i class:unsure={!reading.sure}>{reading.sure ? "sure" : "unsure"}</i>{/if}</dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#each papers as paper, at (at)}
    <button type="button" class="rv-paper" disabled={!paper.id} onclick={() => onpaper?.(paper)}>
      <span class="p-paper" aria-hidden="true">◆</span><span class="rv-pname">{paper.name}</span><span class="clean">scanned clean</span>
      {#if paper.id}<span class="rv-chev" aria-hidden="true">›</span>{/if}
    </button>
  {/each}

  {#if unreadable}<p class="p-prose rv-unread">{unreadable}</p>{/if}

  <div class="rv-acts">
    {#if busy}
      <button class="p-pill filled wide" disabled aria-busy={busy === "approve"}>
        {#if busy === "approve"}<span class="p-body breathing rv-busy" aria-hidden="true"></span>adding…{:else}Add to orbit{/if}
      </button>
      <button class="p-pill wide" disabled aria-busy={busy === "dismiss"}>
        {#if busy === "dismiss"}<span class="p-body breathing rv-busy" aria-hidden="true"></span>dismissing…{:else}Dismiss{/if}
      </button>
    {:else}
      {#if locked}
        <button class="p-pill filled wide" disabled>Add to orbit</button>
      {:else}
        <ArmButton label="Add to orbit" armedLabel="tap again to add" danger={false} wide class="filled rv-yes"
                   name="Add {title} to your orbit" onfire={onapprove} />
      {/if}
      <ArmButton label="Dismiss" armedLabel="tap again to dismiss" wide class="rv-no"
                 name="Dismiss {title}" onfire={ondismiss} />
    {/if}
  </div>
  {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
  {#if !locked}
    <button class="rv-amend" disabled={Boolean(busy)} onclick={onamend}>review &amp; amend →</button>
  {/if}
  {@render after?.()}
</article>

<style>
  .rv-head{display:flex;align-items:flex-start;gap:var(--p-row-gap)}
  .rv-touch{position:relative;flex:none;width:var(--p-row-mark);height:24px;display:grid;place-items:center}
  /* The mark touches down: one ring going out as the card lands. */
  .rv-touch::after{content:"";position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;
    border-radius:50%;border:1.5px solid var(--accent);opacity:0;
    animation:rv-touchdown 900ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 70ms + 260ms)}
  @keyframes rv-touchdown{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3.2)}}
  .rv-words{flex:1;min-width:0}
  .rv-title{margin:0;font:600 var(--p-type-sheet)/1.3 var(--display);color:var(--ink);overflow-wrap:anywhere}
  .rv-when{margin:4px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .rv-when .soon{color:var(--warm-text)}

  /* The readings (.p-kv): label left, value right, how sure the relay was
     in 12px caps after it; a long value wraps under itself, so a pair never
     folds into four lines (§2.6). */
  .rv-reads{margin:12px 0 4px;padding:0}
  .rv-reads .p-kv{align-items:baseline}
  .rv-reads dt{flex:none}
  .rv-reads dd{margin:0;min-width:0;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:baseline;
    gap:4px 8px;text-align:right}
  .rv-reads b{overflow-wrap:anywhere}
  .rv-reads i{font:normal var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ok-text)}
  .rv-reads i.unsure{color:var(--warm-text)}

  /* The attachment line: the paper's name, no size (review round §6.f), on
     one line (round 3 §3.5); a long name is the part the guard trims (R5).
     A button that opens the page (#1155); the count-only fallback (no
     attachment id) stays inert, with no chevron to press. */
  .rv-paper{display:flex;align-items:baseline;gap:8px;margin:8px 0 0;padding:10px 12px;
    border:1px solid var(--line-soft);border-radius:12px;font:var(--p-type-meta)/1.5 var(--mono);color:var(--ink-mid);
    min-height:var(--p-hit);width:100%;text-align:left;appearance:none;background:none;cursor:pointer}
  .rv-paper:disabled{cursor:default}
  .rv-paper:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:12px}
  .rv-pname{min-width:0;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rv-paper .clean{flex:none;white-space:nowrap;color:var(--ok-text)}
  .rv-paper .clean::before{content:"· ";color:var(--ink-quiet)}
  .rv-chev{flex:none;margin-left:auto;color:var(--accent-text)}
  .rv-unread{margin:10px 0 0;color:var(--ink-mid)}

  /* The acts that are the point of the card (§1.5): full width, stacked. */
  .rv-acts{display:flex;flex-direction:column;gap:var(--p-pill-gap);margin-top:16px}
  .rv-acts :global(.p-pill:disabled){opacity:.55;cursor:default;box-shadow:none}
  .rv-busy{display:inline-block;margin-right:10px;color:currentColor;box-shadow:none}
  /* Dismiss burns the arrival: its word takes the danger ink (§1.8). */
  .rv-acts :global(.rv-no){--act:var(--overdue);--act-text:var(--overdue-text)}
  /* Add to orbit, armed, stays the filled accent and lights up: it is a yes. */
  .rv-acts :global(.p-pill.arm.filled.armed){background:var(--accent);border-color:var(--accent);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent), var(--p-pill-glow)}
  .rv-amend{display:flex;align-items:center;justify-content:center;width:100%;min-height:var(--p-hit);margin-top:4px;
    appearance:none;border:0;background:none;padding:0;cursor:pointer;
    font:var(--p-type-meta)/1.2 var(--mono);color:var(--accent-text);letter-spacing:.02em}
  .rv-amend:disabled{opacity:.5}
  .rv-amend:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}
  @media (prefers-reduced-motion:reduce){ .rv-touch::after{animation:none} }
</style>
