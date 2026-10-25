import type { Page } from "@playwright/test";

/**
 * Waits for `count` frames to be drawn by the page itself, not for a stretch
 * of real time. Whatever an event started in the page's own scripts (the
 * handler that ran, the promise chain it set off, a request it issued) has
 * run before the second frame is drawn, so a check that "nothing happened"
 * made after this has looked after the page finished handling the event,
 * however slowly a busy runner got there.
 */
export async function renderedFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const next = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
        next(frames);
      }),
    count,
  );
}
