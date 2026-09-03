<!--
  Second shape of #782, for the {@const} position the issue names: the same
  "multi-line, comma-separated list with a /** @type */ comment on one of
  its own lines" failure, this time as the arguments to a call on the right
  of a {@const}. Fails the production build the same way fails.svelte does.
-->
<script>
  const items = [[1, 2, 3]];
  const decide = (
    /** @type {number} */ a,
    /** @type {number} */ b,
  ) => a + b;
</script>

{#each items as item}
  {@const doubled = decide(
    /** @type {number} */ item[0],
    /** @type {number} */ item[1],
  )}
  <p>{doubled}</p>
{/each}
