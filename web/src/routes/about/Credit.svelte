<script>
  import { licenceId } from "$lib/about/group.js";

  /**
   * One credit row (#1256), in the rhythm of settings' "sent" rows: the name
   * (libraries and sidecars with their version), then one mono line of
   * author · licence · source -- the licence linking to its row in the
   * Licences card, the source a link labelled by its host -- and, only where
   * the licence asks for adaptations to be marked, "changed: …".
   * @typedef {{ entry: import("$lib/about/group.js").Entry }} Props
   */
  /** @type {Props} */
  let { entry } = $props();
  /* Not the last statement on purpose: a typed `$props()` line ending the
     script has its cast comment re-emitted in front of the template's first
     node, which rolldown cannot parse. */
  /* Spelled as a value: whitespace at the edge of a block is trimmed. */
  const SEPARATOR = " · ";
  const title = $derived(entry.version ? `${entry.name} ${entry.version}` : entry.name);
</script>

<div class="credit" id={entry.id}>
  <b>{title}</b>
  <small>{entry.author ? `${entry.author} · ` : ""}{#each entry.licence as part, i (i)}{#if part.key}<!-- A same-page anchor to the Licences card, not a route. --><!-- eslint-disable-next-line svelte/no-navigation-without-resolve --><a href="#{licenceId(part.key)}">{part.text}</a>{:else}{part.text}{/if}{/each}{#if entry.sourceHost}{SEPARATOR}<a rel="external" href={entry.sourceUrl}>{entry.sourceHost}</a>{/if}</small>
  {#if entry.changes}<small>changed: {entry.changes}</small>{/if}
</div>
