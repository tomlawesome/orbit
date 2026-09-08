<!--
  Control for fails.svelte (#782): identical except the two JSDoc comments
  are gone. Builds cleanly through `vite build` / rolldown.
-->
<script>
  /**
   * @param {string} request
   * @param {"approve" | "decline"} action
   */
  const decide = (
    request,
    action,
  ) => request + action;
</script>

<p>{decide("a", "approve")}</p>
