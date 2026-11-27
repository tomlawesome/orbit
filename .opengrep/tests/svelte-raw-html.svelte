<script lang="ts">
  export let body: string;
</script>

<!-- ruleid: svelte-raw-html -->
<div>{@html body}</div>
<!-- ruleid: svelte-raw-html -->
<p>{@html render(body)}</p>
<!-- ok: svelte-raw-html -->
<p>{@html "<br>"}</p>
<!-- ok: svelte-raw-html -->
<p>{body}</p>
