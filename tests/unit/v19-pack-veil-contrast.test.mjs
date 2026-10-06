import { describe, expect, it } from "vitest";

import { OPACITY as VEIL_OPACITY } from "../../web/src/lib/tour/veil.js";
import {
  AA_TEXT_FLOOR,
  AA_UI_FLOOR,
  BLOCKS,
  PACK_NAMES,
  compositeOver,
  contrastRatio,
  groundsFor,
  resolveColor,
} from "./v19-pack-contrast-lib.mjs";

/*
 * #866 checklist item: "WCAG AA on the veil, every pack."
 *
 * veil.js paints one full-viewport sheet, the pack's own --bg at the
 * ratified 0.62 (imported above as VEIL_OPACITY, not retyped — a future
 * change to the ratified value is picked up here automatically instead of
 * silently grading the old one), over whatever the reader was already
 * looking at. Its own header comment argues this introduces no new colour
 * for v19-pack-*-contrast.test.mjs to grade — true for the product's
 * EXISTING panels and text, which stay their own colour, just dimmed
 * together with their background. It is not true for what vocabulary.js
 * paints ON TOP of the veil for the film itself: the callout
 * (`showCallout` in vocabulary.js) and the lift ring (`ringStyle`). Both are
 * new chrome, invented for #866, and neither was graded until this file.
 *
 * THE MATH THIS FILE ADDS: a callout's actual backdrop is not a pack token,
 * it is an alpha composite — the veil (--bg @ 0.62) sitting over whatever
 * ground the reader's screen actually paints there, which this file takes
 * from the SAME three grounds v19-pack-contrast.test.mjs already grades
 * (--bg, --panel over --bg, --panel-raised over --bg — html body's own
 * background plus the two panel tiers actually painted on top of it
 * elsewhere in the product), because a chapter's hole can land anywhere on
 * screen and the veil is exactly as translucent over a panel as it is over
 * bare body. Composite that veiled ground, then composite the callout's own
 * translucent --panel-raised over IT (vocabulary.js's `showCallout`:
 * `background:var(--panel-raised)` plus `backdrop-filter:blur(14px)`, which
 * blends against precisely the layer sitting behind it), and only then
 * measure the callout's ink against the result. The ring has no panel in
 * front of it — `ringStyle`'s innermost stroke, `0 0 0 1.5px var(--accent)`,
 * paints straight onto the veiled ground — so it is measured one layer
 * shallower, as a 3:1 UI-component boundary rather than 4.5:1 text.
 *
 * PACK_NAMES, BLOCKS, groundsFor and the colour maths all come from
 * v19-pack-contrast-lib.mjs, discovered from the real packs.css, so a pack
 * added or a token changed there fails this file without anyone touching it.
 */

/** vocabulary.js's showCallout: two text sites, both under the 18pt/14pt-bold
 *  large-text carve-out (13.5px body copy, 11px uppercase label), so both are
 *  graded at the 4.5:1 normal-text floor, never the softer 3:1 one. */
const CALLOUT_TEXT_TOKENS = ["--ink", "--ink-mid"];

/** The callout's own surface (vocabulary.js's showCallout box) and stroke
 *  (vocabulary.js's ringStyle, the film's lift ring / cut edge). */
const CALLOUT_PANEL_TOKEN = "--panel-raised";
const RING_STROKE_TOKEN = "--accent";

/** Composites the veil (a pack's own --bg at the ratified opacity) over a
 *  ground the reader's screen was already painting — veil.js's actual
 *  mechanic: `background:var(--bg)` at `opacity:${VEIL_OPACITY}` on a sheet
 *  that sits over the live page, never a flat token read at face value.
 *  @param {string} pack @param {number[]} groundRgb */
function veiledGround(pack, groundRgb) {
  const bg = resolveColor(pack, BLOCKS[pack]["--bg"]);
  return compositeOver({ rgb: bg.rgb, alpha: VEIL_OPACITY }, groundRgb);
}

describe("the veil's own chrome clears WCAG 2 AA on every ground it can land on, every pack (#866)", () => {
  it.each(PACK_NAMES)("%s defines --panel-raised and --accent", (pack) => {
    expect(BLOCKS[pack]).toHaveProperty(CALLOUT_PANEL_TOKEN);
    expect(BLOCKS[pack]).toHaveProperty(RING_STROKE_TOKEN);
  });

  it.each(PACK_NAMES)(
    "%s: the callout's text clears 4.5:1 over the veil, on every ground the veil can sit over",
    (pack) => {
      const failures = [];
      for (const ground of groundsFor(pack)) {
        const veiled = veiledGround(pack, ground.rgb);
        const panelRgb = compositeOver(resolveColor(pack, BLOCKS[pack][CALLOUT_PANEL_TOKEN]), veiled);
        for (const token of CALLOUT_TEXT_TOKENS) {
          const inkColor = resolveColor(pack, BLOCKS[pack][token]);
          const inkRgb = compositeOver(inkColor, panelRgb);
          const ratio = contrastRatio(inkRgb, panelRgb);
          if (ratio < AA_TEXT_FLOOR) {
            failures.push(
              `${pack}: ${token} on the callout (${CALLOUT_PANEL_TOKEN} over the veil over ${ground.label}) ` +
                `measured ${ratio.toFixed(2)}:1 — under the 4.5:1 floor`,
            );
          }
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it.each(PACK_NAMES)(
    "%s: the lift ring's stroke clears 3:1 over the veil, on every ground the veil can sit over",
    (pack) => {
      const failures = [];
      const ringColor = resolveColor(pack, BLOCKS[pack][RING_STROKE_TOKEN]);
      for (const ground of groundsFor(pack)) {
        const veiled = veiledGround(pack, ground.rgb);
        const ringRgb = compositeOver(ringColor, veiled);
        const ratio = contrastRatio(ringRgb, veiled);
        if (ratio < AA_UI_FLOOR) {
          failures.push(
            `${pack}: ${RING_STROKE_TOKEN} ring stroke over the veil over ${ground.label} measured ` +
              `${ratio.toFixed(2)}:1 — under the 3:1 UI-boundary floor`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
  );
});
