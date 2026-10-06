<!--
  Third shape of #782, surfaced by #1120 and tracked as #1130: a
  `{#snippet ...}` declared in the markup is hoisted by the compiler above
  an earlier top-level JSDoc comment in the script, into a declaration the
  production bundler cannot parse -- even though the snippet's own
  parameter list carries no comment at all, and the script's doc comment
  is the single-line form that is otherwise fine on `$props()` (see
  props-id-fails.svelte for the sibling shape with `$props.id()` instead of
  a snippet). See the fix on web/src/lib/pocket/Row.svelte, which replaced
  the {#snippet face()} block with a <svelte:element> instead.
-->
<script>
  /** @type {{ title: string }} */
  let { title } = $props();
</script>

{#snippet face()}
  <span>{title}</span>
{/snippet}

<div class="row">{@render face()}</div>
