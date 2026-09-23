import { describe, expect, it } from "vitest";

import {
  AA_TEXT_FLOOR,
  BLOCKS,
  PACK_NAMES,
  compositeOver,
  contrastRatio,
  groundsFor,
  resolveColor,
} from "./v19-pack-contrast-lib.mjs";

/*
 * #861: the text-grade tokens (#491) were graded against each pack's --bg
 * ONLY. Every pack also paints text on a panel — a translucent --panel or
 * --panel-raised sitting over that same --bg — and axe caught in CI what the
 * grading pass never measured: ink that clears 4.5:1 on the bare background
 * can fail once composited under a panel.
 *
 * This file measures every text-carrying ink token, in every pack
 * v19-pack-contrast-lib.mjs discovers from the real packs.css, against all
 * three grounds text actually sits on there: --bg itself, --panel over --bg,
 * and --panel-raised over --bg. A new pack or a changed value is picked up
 * automatically because nothing here is a stored number — only WCAG's own
 * formula and packs.css's own declarations, both in the shared lib.
 */

/*
 * packs.css's own preamble (#491, "THE TEXT-GRADE COMPANIONS") states the
 * contract and names the tokens it covers: "three companions join every
 * pack, and their contract is narrow and literal: they are for INK THAT
 * CARRIES WORDS" — --ink-quiet, --accent-text and --ok-text — "alongside"
 * the base --ink and --ink-mid, which the same preamble treats as already
 * text (it measures --ink-mid's lift in exactly these terms). The preamble
 * is equally explicit about what is deliberately excluded: "--ink-faint is
 * still the hairline, the rule, the tick and the swatch... because a mark is
 * not a letterform" — so --ink-faint is not in this list, on purpose.
 */
const TEXT_TOKENS = ["--ink", "--ink-mid", "--ink-quiet", "--accent-text", "--ok-text"];

describe("packs.css text-carrying ink clears WCAG 2 AA on every ground it is painted on (#861)", () => {
  it.each(PACK_NAMES)("%s defines every text-carrying ink token", (pack) => {
    for (const token of TEXT_TOKENS) {
      expect(BLOCKS[pack]).toHaveProperty(token);
    }
  });

  it.each(PACK_NAMES)("%s: every text-carrying ink token clears 4.5:1 on --bg, --panel and --panel-raised", (pack) => {
    const grounds = groundsFor(pack);
    const failures = [];
    for (const token of TEXT_TOKENS) {
      const raw = BLOCKS[pack][token];
      const inkColor = resolveColor(pack, raw);
      for (const ground of grounds) {
        const inkRgb = compositeOver(inkColor, ground.rgb);
        const ratio = contrastRatio(inkRgb, ground.rgb);
        if (ratio < AA_TEXT_FLOOR) {
          failures.push(
            `${pack}: ${token} (${raw}) measured ${ratio.toFixed(2)}:1 on ${ground.label} — under the 4.5:1 floor`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
