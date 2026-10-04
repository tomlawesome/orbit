<script>
  /*
   * WHAT THE RELAY'S CATCH OPENS INTO ON A PHONE (#1120, review round §2.1,
   * #466): its readings as key/value lines, each with how sure the relay
   * was, then the attachment it came in. The two decisions and `review &
   * amend →` are the row's own (pocket.svelte). A component for the reason
   * ItemDrawer.svelte gives.
   */
  import { papersOf, readingsOf } from "$lib/pocket/review.js";

  /** @type {{ suggestion: import('$lib/data/workspace.js').ReceiptSuggestion, problem?: string | null }} */
  let { suggestion, problem = null } = $props();

  /* The real readings and papers (#1151 W1-Q11), not a second copy of
     review.js's own confidence logic: that copy dropped the lock check
     (readingsOf's `sure` reads null, not a guess, once the key is gone) and
     the attachmentCount guard (a receipt with nothing named drew one blank
     paper row instead of none). */
  const readings = $derived(readingsOf(suggestion));
  const papers = $derived(papersOf(suggestion));
</script>

{#each readings as reading (reading.field)}
  <div class="p-kv"><span>{reading.label}</span>
    <b>{reading.value}{#if reading.sure !== null}<i>{reading.sure ? "sure" : "unsure"}</i>{/if}</b></div>
{/each}
<!-- The paper's name where the data holds one (review round §6.f, round 3
     §2), no size; else the count the list gives. -->
{#each papers as paper (paper.id ?? paper.name)}
  <p class="attached"><span class="p-paper" aria-hidden="true">◆</span><span class="name">{paper.name}</span><span class="clean">scanned clean</span></p>
{/each}
{#if problem}<p class="p-error" role="alert">{problem}</p>{/if}

<style>
  .p-kv{align-items:baseline}
  .p-kv span{flex:none}
  .p-kv b{min-width:0;text-align:right;overflow-wrap:anywhere}
  /* How sure the relay was: 12px caps after the value. */
  .p-kv i{font:normal var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ink-quiet);margin-left:8px}
  .attached{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin:0;padding:8px 0 0;
    font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink)}
  .attached .name{min-width:0;overflow-wrap:anywhere}
  .clean{color:var(--ok-text)}
  .clean::before{content:"· ";color:var(--ink-quiet)}
</style>
