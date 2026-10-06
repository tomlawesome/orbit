import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q4: the tron and sonde glints each hand-wrote the identical pair
 * of reticle-tick <line>s at the glint's fixed ±13.4 footprint. The file's
 * own comments say that footprint must stay fixed across every glint form,
 * so a future change to it had no structural reason to touch both copies.
 *
 * The fix defines the ticks once in <defs> and both glints <use> it — the
 * same reuse idiom NEWCOMER_FAR/NEWCOMER_NEAR already use elsewhere in this
 * codebase for repeated geometry — so the two glints keep their own
 * stroke/width/opacity styling on the wrapping <g> while sharing the actual
 * coordinates.
 */

const MARK = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/NorthStarMark.svelte"),
  "utf8",
);

describe("#1151 W1-Q4: one shared reticle-tick definition", () => {
  it("defines the ticks once, per instance, in <defs>", () => {
    expect(MARK).toMatch(/<g id="\{uid\}-reticle"><line x1="-13\.4" y1="0" x2="-10" y2="0"\/><line x1="10" y1="0" x2="13\.4" y2="0"\/><\/g>/u);
  });

  it("both glints reference it with <use>, keeping their own styled wrapper", () => {
    const matches = [...MARK.matchAll(/<use href="\{uid\}-reticle"\/>|<use href="#\{uid\}-reticle"\/>/gu)];
    expect(matches.length).toBe(2);
  });

  it("the tick coordinates no longer appear hand-written a second time", () => {
    const occurrences = [...MARK.matchAll(/<line x1="-13\.4" y1="0" x2="-10" y2="0"\/>/gu)];
    expect(occurrences.length).toBe(1);
  });
});
