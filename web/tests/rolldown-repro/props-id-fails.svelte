<!--
  Fourth shape of #782, tracked as #1130: `$props.id()`, called after an
  earlier top-level JSDoc comment has already closed in the script, fails
  the production build. Svelte hoists `$props.id()`'s compiled declaration,
  and drags the earlier doc comment into a position rolldown cannot parse.

  Both halves are load-bearing: dropping the `/** @type */` comment above
  `$props()`, or moving `$props.id()` to be the first statement (so no
  comment has closed yet when it is reached), each make this build cleanly
  -- see the fix on web/src/lib/pocket/Sheet.svelte and
  web/src/lib/pocket/Hatch.svelte ("First, with no comment of its own").
  A comment that is not JSDoc (`/* ... */`, single star) ahead of the call
  is fine; a plain block comment is what those two files moved to.
-->
<script>
  /** @type {{ size?: number }} */
  let { size = 30 } = $props();
  const uid = $props.id();
</script>

<p>{size} {uid}</p>
