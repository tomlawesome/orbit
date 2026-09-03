<!--
  Control for fails.svelte (#782): identical except the two JSDoc comments
  are gone. Builds cleanly through `vite build` / rolldown.
-->
<script>
  const decide = (
    request,
    action,
  ) => request + action;
</script>

<p>{decide("a", "approve")}</p>
