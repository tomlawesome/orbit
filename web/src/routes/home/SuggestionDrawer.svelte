<script>
  /*
   * WHAT THE RELAY'S CATCH OPENS INTO ON A PHONE (#1120, review round §2.1,
   * #466): its readings as key/value lines, each with how sure the relay
   * was, then the attachment it came in. The two decisions and `review &
   * amend →` are the row's own (pocket.svelte). A component for the reason
   * ItemDrawer.svelte gives.
   */
  import { money } from "$lib/format.js";

  /** @type {{ suggestion: import('$lib/data/workspace.js').ReceiptSuggestion, problem?: string | null }} */
  let { suggestion, problem = null } = $props();

  /** @type {Record<string, string>} */
  const EVIDENCE = { provider: "provider", renewsOn: "dueDate", costMinor: "costMinor" };
  /** @param {string} field */
  const sureness = (field) => {
    const evidence = suggestion.fieldEvidence?.[EVIDENCE[field]];
    return evidence ? (evidence.confidence === "low" ? "unsure" : "sure") : "";
  };
  const papers = $derived(
    suggestion.attachments?.length
      ? suggestion.attachments.map((one) => one.displayName ?? "document")
      : [suggestion.sourceDocument]);
  /** @param {string} iso */
  const long = (iso) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
</script>

{#if suggestion.provider}
  <div class="p-kv"><span>provider</span><b>{suggestion.provider}{#if sureness("provider")}<i>{sureness("provider")}</i>{/if}</b></div>
{/if}
{#if suggestion.renewsOn}
  <div class="p-kv"><span>{suggestion.scheduleKind === "expiry" ? "ends" : "renews"}</span>
    <b>{long(suggestion.renewsOn)}{#if sureness("renewsOn")}<i>{sureness("renewsOn")}</i>{/if}</b></div>
{/if}
{#if suggestion.costMinor}
  <div class="p-kv"><span>cost</span>
    <b>{money(suggestion.costMinor, suggestion.currency, true)}{#if sureness("costMinor")}<i>{sureness("costMinor")}</i>{/if}</b></div>
{/if}
<!-- The paper's name where the data holds one (review round §6.f, round 3
     §2), no size; else the count the list gives. -->
{#each papers as name, index (index)}
  <p class="attached"><span class="p-paper" aria-hidden="true">◆</span><span class="name">{name}</span><span class="clean">scanned clean</span></p>
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
