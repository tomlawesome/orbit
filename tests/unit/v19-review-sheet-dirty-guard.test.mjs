import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-S2 (the other half): Sheet.svelte's confirmDiscard prop
 * (v19-sheet-confirm-discard.test.mjs pins that half) was only wired for
 * the desktop create form — the review-and-amend sheet (ReviewSheet.svelte)
 * never passed it, so a scrim tap or drag-down still discarded an amended
 * proposal outright, which was the finding's own worst case.
 *
 * The fix takes a snapshot of the freshly-built entry (`start`) the same
 * moment `entry` itself is built in the existing $effect.pre, and passes a
 * `dirty` closure as confirmDiscard that compares the two with entry.js's
 * own entryChanged — the same comparison the create form (pocket.svelte)
 * and the belt's edit panel (W1-S5) already use.
 */

const REVIEW_SHEET = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/pocket/ReviewSheet.svelte"),
  "utf8",
);

describe("#1151 W1-S2: ReviewSheet passes confirmDiscard through to the sheet", () => {
  it("imports entryChanged alongside the rest of entry.js's helpers", () => {
    expect(REVIEW_SHEET).toMatch(/import \{ entryChanged, entryOfProposal, refusalOf, reviewItemOf \} from/u);
  });

  it("snapshots a start value the same moment entry is rebuilt", () => {
    const effect = REVIEW_SHEET.slice(REVIEW_SHEET.indexOf("$effect.pre("), REVIEW_SHEET.indexOf("const household"));
    expect(effect).toMatch(/entry = entryOfProposal\(proposal \?\? \{\}, \{ householdId \}\);/u);
    expect(effect).toMatch(/start = \$state\.snapshot\(entry\);/u);
  });

  it("dirty() reads entryChanged against that start value", () => {
    expect(REVIEW_SHEET).toMatch(
      /const dirty = \(\) => Boolean\(entry && start && entryChanged\(entry, start\)\);/u,
    );
  });

  it("the sheet actually receives it as confirmDiscard", () => {
    expect(REVIEW_SHEET).toMatch(/<Sheet bind:open size="full" title="Review & amend" confirmDiscard=\{dirty\}>/u);
  });
});
