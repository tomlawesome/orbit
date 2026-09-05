import { readDueNext } from "$lib/data/workspace.js";

/**
 * The corridor's own view state, extracted to a `.svelte.js` module so the
 * `$state` declaration can carry a real type (#624/#782): the identical
 * declaration inline in `+page.svelte`'s `<script>` parses fine for
 * svelte-check but makes the production rolldown build fail to parse the
 * file, for reasons not yet root-caused (tracked in #782). Declaring it here
 * instead sidesteps the bug rather than working around it blind.
 */
export function createDueNextViewState() {
  /** @type {Awaited<ReturnType<typeof readDueNext>> | null} */
  let value = $state(null);
  /** @type {string | null} household id, or null = all systems */
  let filter = $state(null);
  return {
    get value() {
      return value;
    },
    async load() {
      value = await readDueNext();
    },
    get filter() {
      return filter;
    },
    set filter(next) {
      filter = next;
    },
  };
}
