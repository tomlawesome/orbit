import type { Locator, Page } from "@playwright/test";

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

/**
 * Waits until the page has no finite animation or transition left running,
 * leaving its endless loops running to be judged. `getAnimations()` includes
 * CSS transitions, so a fade that is still on its way counts. After the last
 * one ends the page draws `quietFrames` more frames (a counted number, not
 * time) and is looked at again: an entrance that only began once the screen
 * had drawn is waited for too, and the wait ends only on a look that finds
 * nothing finite running. An animation or transition that is cancelled (its
 * element left) counts as done.
 */
export async function finiteMotionSettled(page: Page, quietFrames = 30): Promise<void> {
  for (let pass = 0; pass < 30; pass += 1) {
    const ranAgain = await page.evaluate(async (frames) => {
      const finiteRunning = () =>
        document
          .getAnimations()
          .filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(finiteRunning().map((a) => a.finished.catch(() => undefined)));
      await new Promise<void>((resolve) => {
        const next = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
        next(frames);
      });
      return finiteRunning().length > 0;
    }, quietFrames);
    if (!ranAgain) return;
  }
}
