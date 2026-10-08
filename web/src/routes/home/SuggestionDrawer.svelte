<script>
  /*
   * WHAT THE RELAY'S CATCH OPENS INTO ON A PHONE (#1120, review round §2.1,
   * #466): its readings as key/value lines, each with how sure the relay
   * was, then the attachment it came in. The two decisions and `review &
   * amend →` are the row's own (pocket.svelte). A component for the reason
   * ItemDrawer.svelte gives.
   *
   * #1319 (owner-decisions §34: a suggestion is reviewed in its home drawer,
   * not on the belt): the paper opens the preview as the bottom sheet, as a
   * filed item's papers do (ItemDrawer.svelte), with the belt's own staged
   * states — attached on acceptance, nothing to download or remove.
   */
  import { readingsOf } from "$lib/pocket/review.js";
  import { suggestionPapersOf } from "$lib/data/belt.js";

  /** @typedef {import('$lib/data/workspace.js').DrawerDocument & { itemId: string, itemTitle: string }} StagedPaper */
  /** @type {{
   *   suggestion: import('$lib/data/workspace.js').ReceiptSuggestion,
   *   problem?: string | null,
   *   showingPaper?: string | null,
   *   onopenpaper?: (paper: StagedPaper, from: HTMLElement) => void,
   * }} */
  let { suggestion, problem = null, showingPaper = null, onopenpaper = undefined } = $props();

  /* The real readings and papers (#1151 W1-Q11), not a second copy of
     review.js's own confidence logic: that copy dropped the lock check
     (readingsOf's `sure` reads null, not a guess, once the key is gone) and
     the attachmentCount guard (a receipt with nothing named drew one blank
     paper row instead of none). The papers are the belt's staged rows, so
     the preview sheet can open each; `itemId` is what puts the sheet away
     when this row closes. */
  const readings = $derived(readingsOf(suggestion));
  const papers = $derived(suggestionPapersOf(suggestion)
    .map((paper) => ({ ...paper, itemId: suggestion.id, itemTitle: suggestion.title })));
</script>

{#each readings as reading (reading.field)}
  <div class="p-kv"><span>{reading.label}</span>
    <b>{reading.value}{#if reading.sure !== null}<i>{reading.sure ? "sure" : "unsure"}</i>{/if}</b></div>
{/each}
<!-- The paper's name where the data holds one (review round §6.f, round 3
     §2), no size; else the count the list gives. -->
{#each papers as paper (paper.id)}
  {@const on = showingPaper === paper.id}
  <button type="button" class="attached" class:showing={on} data-doc-row aria-haspopup="dialog"
          aria-current={on ? "true" : undefined} aria-label="Open {paper.name}"
          onclick={(event) => onopenpaper?.(paper, event.currentTarget)}>
    <span class="p-paper" aria-hidden="true">◆</span><span class="name">{paper.name}</span>{#if paper.clean}<span class="clean">scanned clean</span>{/if}
  </button>
{/each}
{#if problem}<p class="p-error" role="alert">{problem}</p>{/if}

<style>
  .p-kv{align-items:baseline}
  .p-kv span{flex:none}
  .p-kv b{min-width:0;text-align:right;overflow-wrap:anywhere}
  /* How sure the relay was: 12px caps after the value. */
  .p-kv i{font:normal var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ink-quiet);margin-left:8px}
  .attached{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin:0;padding:8px 0;
    width:100%;min-height:var(--p-hit);box-sizing:border-box;text-align:left;cursor:pointer;
    background:none;border:0;-webkit-appearance:none;appearance:none;-webkit-tap-highlight-color:transparent;
    font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink)}
  .attached:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
  /* the open one wears the accent at its left edge and on its name (round 3) */
  .attached.showing{border-left:3px solid var(--accent);padding-left:8px}
  .attached.showing .name{color:var(--accent-text)}
  .attached .name{min-width:0;overflow-wrap:anywhere}
  .clean{color:var(--ok-text)}
  .clean::before{content:"· ";color:var(--ink-quiet)}
</style>
