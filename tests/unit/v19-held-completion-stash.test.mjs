import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R5 (the belt's item page, retired in #1319) and W1-S3
 * (home/pocket.svelte): a completion held for the undo wake, then flushed on leave, used to be sent
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
 * The pocket has no import surface a plain async-flow test can drive
 * without a browser — so, the way `v19-flight-mark-ride.test.mjs` pins a
 * `.svelte` fix, this pins the mechanism against the files' own text.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const HOME_POCKET = read("web/src/routes/home/pocket.svelte");
const HELD_LIB = read("web/src/lib/data/held-completion.js");

describe("#1151 W1-R5/W1-S3: a held completion is stashed before it is sent", () => {
  it("home/pocket.svelte holds no completion since #1319 stage 2: complete asks first, then records at once", () => {
    expect(HOME_POCKET).not.toMatch(/stashHeldCompletion|WAKE_HOLD_MS/u);
  });

  it("home/pocket.svelte: a leftover stash is retried and a version conflict counts as success", () => {
    expect(HOME_POCKET).toMatch(/readHeldCompletionStash\(\)/u);
    expect(HOME_POCKET).toMatch(/error\.code === "version_conflict"/u);
  });

  it("the pocket stashes under the same literal key as lib/data/held-completion.js", () => {
    const keyOf = (source) => source.match(/HELD_COMPLETION_KEY = "([^"]+)"/u)?.[1];
    expect(keyOf(HELD_LIB)).toBe("orbit:pending-completion");
    expect(keyOf(HOME_POCKET)).toBe(keyOf(HELD_LIB));
  });
});
