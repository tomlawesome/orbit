import type { Locator } from "@playwright/test";

/**
 * Waits for every one-shot entrance under `root` (a CSS rise, a fade, a
 * landing) to finish, leaving its endless ambient loops (a slowly turning
 * year, a breathing ring) running. #1120: the pocket screens rise into
 * place over their first ~800ms, and a check that reads the screen before
 * then reads it half-drawn: axe measures contrast through the fading
 * opacity, and the keyboard audit counts a control at opacity 0 as not
 * shown. An entrance that is cancelled (the element left) counts as done.
 */
export async function entrancesSettled(root: Locator) {
  await root.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}
