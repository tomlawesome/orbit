/**
 * THE PREVIEW BESIDE THE DRAWER (#1319; design/v19/belt-purpose/round-3/
 * f-preview-beside-tracked.html, direction F, owner-decisions §34): the
 * geometry the desk's home needs to stand a document's preview card beside
 * the open item drawer, as plain arithmetic so it is proved here rather
 * than discovered in a browser.
 *
 * On a wide screen (WIDE_QUERY) the card is the open item card's sibling: a
 * column at the manifest's right whose top is the item card's top and whose
 * height is the item card's height, the card sticky inside it at the page's
 * 84px gutter. The manifest column slides left and narrows only as far as it
 * must, so the drawer and the card are centred together, clear of the
 * health tab at the left and the key tab at the right. Under it the card is
 * the phone's bottom sheet and the manifest stays put.
 */

/** Where the card stands beside the drawer; under this it is the bottom sheet. */
export const WIDE_QUERY = "(min-width: 1200px)";
/** The page's top gutter the card is sticky at: clear of the top-right orbs. */
export const CARD_TOP = 84;
/** The room the card keeps under it. */
export const CARD_BOTTOM = 16;
/** The gap between the drawer and the card (round 6's lane gap). */
export const PAIR_GAP = 28;
/** The corridor's left gutter, where the spine lives (home.css `.corridor`). */
export const SPINE = 46;
/** The manifest's own width when nothing stands beside it (home.css). */
export const MANIFEST_W = 820;
/** The health tab at the left and the key tab at the right, never covered. */
export const CLEAR_LEFT = 64;
export const CLEAR_RIGHT = 56;
/** The card's own chrome around the page: padding, the pager, the gap. */
const CARD_CHROME = 62;
const PAGE_AIR = 18;
/** The card's widest, and narrowest. */
const CARD_MAX = 480;
const CARD_MIN = 220;
/** The card's side padding and the sheet's own, around an A4 page. */
const CARD_SIDES = 18 + 22;

/**
 * The height the page itself may take in the card on a wide screen: the
 * window less the gutters and the card's chrome, never under 120px.
 * @param {number} viewportHeight
 */
export function pageRoomOf(viewportHeight) {
  return Math.max(120, viewportHeight - CARD_TOP - CARD_BOTTOM - CARD_CHROME - PAGE_AIR);
}

/**
 * The card's width on a wide screen: an A4 page at the height the window
 * leaves, plus the card's sides, held between 220px and 480px (the mockup's
 * expectedReadw), so the pair is laid out once rather than after the page
 * has landed.
 * @param {number} viewportHeight
 */
export function cardWidthOf(viewportHeight) {
  return Math.min(CARD_MAX, Math.max(CARD_MIN, Math.ceil(pageRoomOf(viewportHeight) / Math.SQRT2) + CARD_SIDES));
}

/**
 * The manifest's width and sideways shift that centre the drawer and the
 * card together (the mockup's pairLayout). The drawer keeps the manifest's
 * own width if the pair fits; if not it gives up only what it must, so the
 * card is never squeezed.
 *
 * @param {{ viewportWidth: number, hostLeft: number, hostWidth: number, cardWidth: number }} frame
 *   `hostLeft` and `hostWidth` are the manifest's container's content box.
 * @returns {{ maxWidth: number, shift: number }}
 */
export function pairOf({ viewportWidth, hostLeft, hostWidth, cardWidth }) {
  const natural = Math.min(MANIFEST_W, hostWidth);
  const rightEdge = viewportWidth - CLEAR_RIGHT;
  const drawer = Math.min(natural - SPINE, rightEdge - CLEAR_LEFT - PAIR_GAP - cardWidth);
  const pair = drawer + PAIR_GAP + cardWidth;
  const left = Math.min(Math.max((viewportWidth - pair) / 2, CLEAR_LEFT), rightEdge - pair);
  const maxWidth = drawer + SPINE;
  return { maxWidth, shift: Math.round(left - SPINE - (hostLeft + (hostWidth - maxWidth) / 2)) };
}

/**
 * Where the card's column stands in the manifest: from the item card's top
 * to the drawer's bottom. Offsets, not rects, so the drawer's own opening
 * slide (6px) never moves it.
 *
 * @param {{ rowTop: number, rowOffsetTop: number, viewOffsetTop: number, viewHeight: number }} measured
 *   `rowTop` is the row's top within the manifest; the other three are
 *   offsets within the row's and the drawer's shared offset parent.
 * @returns {{ top: number, height: number }}
 */
export function trackOf({ rowTop, rowOffsetTop, viewOffsetTop, viewHeight }) {
  return { top: rowTop, height: viewOffsetTop + viewHeight - rowOffsetTop };
}
