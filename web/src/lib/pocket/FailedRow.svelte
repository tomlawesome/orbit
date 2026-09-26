<script>
  import { receiptWords } from "$lib/data/metadata-status.js";
  import Row from "./Row.svelte";
  import { firstClause } from "./words.js";

  /**
   * A MESSAGE THAT COULD NOT BE READ (round 3 §3.5, §3.8): the one drawing
   * of a failed arrival, shared by the inbox and settings › mail. Title the
   * day it came, meta the server's first clause (R6), the failed body for
   * a mark. A tap opens it: the whole message as `.p-prose`, then `remove`
   * (arms) where the server lets it go (`canDiscard`); one it keeps opens to
   * its message alone.
   * @typedef {{
   *   failure: { id: string, receivedAt: string, message: string, canDiscard?: boolean,
   *     metadataStatus?: { proposal?: string, fieldEvidence?: string } | null },
   *   onremove?: (failure: { id: string }) => unknown,
   * }} Props
   */
  /** @type {Props} */
  let { failure, onremove = undefined } = $props();

  const day = $derived(
    new Date(failure.receivedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }));
  /* What Orbit cannot read about it (#941) outranks the server's message. */
  const words = $derived(receiptWords(failure.metadataStatus) ?? failure.message ?? "");
  const acts = $derived(failure.canDiscard && onremove ? [{
    label: "remove", name: `Remove the message from ${day}`, danger: true,
    onact: () => onremove?.(failure),
  }] : []);
</script>

<Row title="A message from {day}" meta={firstClause(words)} metaFace="ui" key={failure.id} {acts}>
  {#snippet mark()}<span class="p-body p-failed-mark"></span>{/snippet}
  {#snippet detail()}<p class="p-prose p-failed-words">{words}</p>{/snippet}
</Row>

<style>
  /* The kit's .p-body.failed under another name: the desk's inbox draws a
     whole card as `.failed`, and the pocket is drawn inside its page. */
  :global(.p-body.p-failed-mark){color:var(--degraded)}
  .p-failed-words{margin:0;color:var(--ink-mid)}
</style>
