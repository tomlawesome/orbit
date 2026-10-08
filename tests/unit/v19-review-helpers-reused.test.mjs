import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q11 (home/SuggestionDrawer.svelte) and W1-Q14
 * (inbox/+page.svelte): both re-derived review.js's own confidence and
 * attachment-listing logic instead of importing `readingsOf`/`papersOf`,
 * and each copy dropped something the real helpers already carry:
 *
 *  - the lock check — `readingsOf`'s `sure` reads null (no mark drawn) once
 *    `evidenceReadable(metadataStatus)` is false, so a key gone for repair
 *    does not keep showing a confidence mark it can no longer stand behind
 *    (#941); the copies in both files skipped straight to reading
 *    `fieldEvidence` with no such gate.
 *  - the attachmentCount guard — `papersOf` falls back to one row naming the
 *    honest count when there are no named attachments; SuggestionDrawer's
 *    copy fell back to `[suggestion.sourceDocument]`, which is `[undefined]`
 *    — a blank paper row — whenever neither existed.
 *  - the PDF-only `drawable` gate on the attachment's "view →" link —
 *    inbox/+page.svelte's copy made every attachment with an id clickable,
 *    whatever its media type; the phone inbox (inbox/pocket.svelte) already
 *    imports the real `papersOf` and gates on `drawable` correctly.
 *
 * Both fixes import the real helpers and delete the copy, so this pins two
 * things: that the re-derivation is actually gone, and that the real
 * helpers are what the templates now call.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

describe("#1151 W1-Q11: SuggestionDrawer imports the real review helpers", () => {
  const source = read("web/src/routes/home/SuggestionDrawer.svelte");

  it("imports readingsOf from review.js", () => {
    expect(source).toMatch(/import \{ readingsOf \} from "\$lib\/pocket\/review\.js";/u);
  });

  /* #1319: the papers open the preview sheet now, so they are the belt's
     staged rows (belt.js suggestionPapersOf), which carry the same count
     guard: no named paper and no count is no row, never a blank one. */
  it("takes its papers from the shared staged rows, never a copy", () => {
    expect(source).toMatch(/import \{ suggestionPapersOf \} from "\$lib\/data\/belt\.js";/u);
  });

  it("the shared rows draw no blank paper when nothing is named or counted", async () => {
    const { suggestionPapersOf } = await import("../../web/src/lib/data/belt.js");
    const bare = { id: "r-1", receiptId: "r-1", householdId: null, title: "x", currency: "GBP", sourceDocument: undefined };
    expect(suggestionPapersOf(/** @type {any} */ (bare))).toEqual([]);
    expect(suggestionPapersOf(/** @type {any} */ ({ ...bare, attachmentCount: 2 })).map((p) => p.name))
      .toEqual(["forwarded document 1", "forwarded document 2"]);
  });

  it("no longer carries its own confidence or attachment-listing copy", () => {
    expect(source).not.toMatch(/fieldEvidence/u);
    expect(source).not.toMatch(/sourceDocument/u);
  });
});

describe("#1151 W1-Q14: the desktop inbox imports the real review helpers", () => {
  const source = read("web/src/routes/inbox/+page.svelte");

  it("imports readingsOf and papersOf from review.js", () => {
    expect(source).toMatch(/import \{ papersOf, readingsOf \} from "\$lib\/pocket\/review\.js";/u);
  });

  it("no longer carries its own confidence or chip-listing copy", () => {
    expect(source).not.toMatch(/const mark = /u);
    expect(source).not.toMatch(/const chips = /u);
  });

  it("the attachment link is gated on the real PDF-only drawable flag", () => {
    expect(source).toMatch(/\{#each papersOf\(receipt\) as paper/u);
    expect(source).toMatch(/\{#if paper\.drawable\}/u);
  });
});
