import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R5 (item/[[id]]/+page.svelte) and W1-S3 (home/pocket.svelte): a
 * completion held for the undo wake, then flushed on leave, used to be sent
 * with a bare `.catch(() => {})` — a request cut off by the page actually
 * unloading (as opposed to merely refused) vanished with nothing said, and
 * the item quietly stayed "not completed" with no trace it was ever tried.
 *
 * The fix stashes the built command in `localStorage` before the first send
 * attempt, under the same literal key in both files, and clears it only on
 * confirmed success (including a version conflict, which means the send
 * landed after all); the next load of either screen picks up a leftover
 * stash and finishes the job, surfacing a failure through that screen's own
 * existing error pattern (item's `problem` banner; pocket's `wake(...,
 * { failure: true })` toast) rather than losing it silently.
 *
 * Neither file has an import surface a plain async-flow test can drive
 * without a browser — so, the way `v19-flight-mark-ride.test.mjs` pins a
 * `.svelte` fix, this pins the mechanism against the files' own text.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ITEM_PAGE = read("web/src/routes/item/[[id]]/+page.svelte");
const HOME_POCKET = read("web/src/routes/home/pocket.svelte");

describe("#1151 W1-R5/W1-S3: a held completion is stashed before it is sent", () => {
  for (const [name, source] of [["item/[[id]]/+page.svelte", ITEM_PAGE], ["home/pocket.svelte", HOME_POCKET]]) {
    it(`${name}: the leave-time flush is stashed first and cleared only on success`, () => {
      // a bare `.catch(() => {})` on the leave-time send is no longer the
      // whole story: it is harmless now, because the stash set below
      // already covers the failure case, and is cleared only once the send
      // actually confirms.
      expect(source).toMatch(/localStorage\.setItem\(HELD_COMPLETION_KEY/u);
      expect(source).toMatch(/applyCommand\(job\.command\)\.then\((\(\) => )?clearHeldCompletionStash(\(job\.command\))?\)\.catch/u);
    });

    it(`${name}: a leftover stash is retried and a version conflict counts as success`, () => {
      expect(source).toMatch(/readHeldCompletionStash\(\)/u);
      expect(source).toMatch(/error\.code === "version_conflict"/u);
    });
  }

  it("both screens stash under the same literal key", () => {
    const keyOf = (source) => source.match(/HELD_COMPLETION_KEY = "([^"]+)"/u)?.[1];
    expect(keyOf(ITEM_PAGE)).toBe("orbit:pending-completion");
    expect(keyOf(HOME_POCKET)).toBe(keyOf(ITEM_PAGE));
  });
});
