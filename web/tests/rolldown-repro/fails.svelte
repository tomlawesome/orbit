<!--
  Minimal reproduction for #782: a SvelteKit route file whose <script> holds
  a multi-line, comma-separated arrow-parameter list with a /** @type */
  JSDoc comment on any one of its entries fails to parse in the production
  build (`vite build`, which bundles through rolldown), even though
  svelte-check and `vite dev` both accept it without complaint.

  The comment's CONTENT does not matter and neither does which parameter
  carries it (see run.mjs) -- what matters is: (a) two or more parameters,
  (b) each on its own line, and (c) at least one preceded by a /** ... */
  block comment. A single-line comment (//) does not trigger it, and
  neither does a single parameter alone on its own line.

  The same shape breaks inside a {@const ...} expression when the value on
  the right is itself a multi-line, comment-bearing argument list -- see
  const-fails.svelte.

  Compare passes.svelte, which is character-for-character identical minus
  the two JSDoc comments, and builds cleanly.

  Run `node tests/rolldown-repro/run.mjs` from web/ to see both outcomes
  reproduced against the real toolchain.
-->
<script>
  const decide = (
    /** @type {string} */ request,
    /** @type {"approve" | "decline"} */ action,
  ) => request + action;
</script>

<p>{decide("a", "approve")}</p>
