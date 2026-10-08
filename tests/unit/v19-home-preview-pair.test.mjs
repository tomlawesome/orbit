import { describe, expect, it } from "vitest";

import {
  CLEAR_LEFT, CLEAR_RIGHT, MANIFEST_W, PAIR_GAP, SPINE, cardWidthOf, pageRoomOf, pairOf, trackOf,
} from "../../web/src/routes/home/preview-pair.js";

/*
 * #1319 (design/v19/belt-purpose/round-3/f-preview-beside-tracked.html,
 * direction F): on a wide screen a document's preview stands beside the
 * open drawer, the two centred together. The arithmetic is the mockup's
 * own (expectedReadw, pairLayout, placeTrack), proved here at the frames
 * the round was judged in: 1280x800 and 1440x900.
 */

/** home.css: `.desk .page` is 1160px wide at most, with 24px sides. */
const hostOf = (viewportWidth) => {
  const page = Math.min(1160, viewportWidth);
  return { hostLeft: (viewportWidth - page) / 2 + 24, hostWidth: page - 48 };
};

describe("the card's width", () => {
  it("is an A4 page at the height the window leaves, plus its sides", () => {
    expect(pageRoomOf(800)) .toBe(620);
    expect(cardWidthOf(800)).toBe(479);
    expect(cardWidthOf(900)).toBe(480);
  });

  it("never runs under 220px or over 480px", () => {
    expect(cardWidthOf(200)).toBe(220);
    expect(cardWidthOf(2000)).toBe(480);
  });
});

describe("the pair", () => {
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080], [1200, 700]]) {
    it(`at ${width}x${height} centres the drawer and the card together, clear of both tabs`, () => {
      const host = hostOf(width);
      const cardWidth = cardWidthOf(height);
      const { maxWidth, shift } = pairOf({ viewportWidth: width, ...host, cardWidth });
      /* where the manifest's spine and the card's right edge land */
      const manifestLeft = host.hostLeft + (host.hostWidth - maxWidth) / 2 + shift;
      const drawerLeft = manifestLeft + SPINE;
      const cardRight = manifestLeft + maxWidth + PAIR_GAP + cardWidth;
      expect(drawerLeft).toBeGreaterThanOrEqual(CLEAR_LEFT - 1);
      expect(cardRight).toBeLessThanOrEqual(width - CLEAR_RIGHT + 1);
      /* centred, unless a tab holds it in */
      const slack = Math.abs(drawerLeft - (width - cardRight));
      if (drawerLeft > CLEAR_LEFT + 1 && cardRight < width - CLEAR_RIGHT - 1) expect(slack).toBeLessThanOrEqual(2);
      /* the drawer gives up only what it must */
      expect(maxWidth).toBeLessThanOrEqual(MANIFEST_W);
    });
  }

  it("keeps the manifest's own width when there is room for both", () => {
    const host = hostOf(2400);
    const { maxWidth } = pairOf({ viewportWidth: 2400, ...host, cardWidth: 480 });
    expect(maxWidth).toBe(MANIFEST_W);
  });

  it("narrows the drawer, never the card, when there is not", () => {
    const host = hostOf(1280);
    const { maxWidth } = pairOf({ viewportWidth: 1280, ...host, cardWidth: 479 });
    expect(maxWidth).toBe(1280 - CLEAR_RIGHT - CLEAR_LEFT - PAIR_GAP - 479 + SPINE);
    expect(maxWidth).toBeLessThan(MANIFEST_W);
  });
});

describe("the card's column", () => {
  it("runs from the item card's top to the drawer's foot", () => {
    expect(trackOf({ rowTop: 1240, rowOffsetTop: 300, viewOffsetTop: 362, viewHeight: 540 }))
      .toEqual({ top: 1240, height: 602 });
  });
});
