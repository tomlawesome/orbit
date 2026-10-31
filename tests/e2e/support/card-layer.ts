import type { Page } from "@playwright/test";

/** What the card-layer watcher has seen: samples that found a layer, and the page's changes it was woken by. */
export type CardLayerSamples = { drawn: number; changes: number };

/**
 * Whether a sign-in card layer was EVER drawn over the newcomer's frame, from
 * inside the page, with no clock in it: a MutationObserver installed before
 * the document that flies looks after every change to the document (a node
 * added, a class or style changed) and notes whether any `.ringcard` has a box
 * while the newcomer's own frame (`.nf`) is in the document. A layer that
 * flashed up and went again in between polls from outside is still caught,
 * which is what a poll cannot promise (the same reason witnessBodyClasses is
 * an observer). It counts appearances and asks nothing of how many there were
 * to look at: that nothing was drawn is the end state, not a number of frames.
 *
 * Two guards, neither of which counts a frame or a second (T-Q34, L-Q3). A
 * watcher that never ran must not read as a page with nothing on it, so the
 * observer's callbacks are counted (`changes`) and the caller asserts there
 * was at least one. And a layer can gain a box by CSS alone, with no change
 * to the document for the observer to hear, so the watcher also samples at the
 * start of every animation and the start and end of every transition.
 */
export async function watchCardLayer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: CardLayerSamples = { drawn: 0, changes: 0 };
    (window as unknown as { __orbitCardLayer: CardLayerSamples }).__orbitCardLayer = seen;
    const sample = () => {
      if (document.querySelector(".nf") && [...document.querySelectorAll(".ringcard")].some((layer) => layer.getClientRects().length > 0)) {
        seen.drawn += 1;
      }
    };
    new MutationObserver(() => {
      seen.changes += 1;
      sample();
    }).observe(document, { subtree: true, childList: true, attributes: true });
    for (const type of ["animationstart", "transitionrun", "transitionend"]) {
      document.addEventListener(type, sample, true);
    }
  });
}

export async function cardLayerSamples(page: Page): Promise<CardLayerSamples> {
  return page.evaluate(() => (window as unknown as { __orbitCardLayer: CardLayerSamples }).__orbitCardLayer);
}
