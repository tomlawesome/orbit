import type { Page } from "@playwright/test";

/**
 * Playwright's WebKit build has no push service behind PushManager. Once
 * Orbit's service worker is registered, `pushManager.getSubscription()` never
 * settles and blocks the page for good: measured on desktop-webkit, the call
 * held the page's main thread so that `page.evaluate` went unanswered for 87s
 * while WebKit's web process sat asleep in poll(). /settings makes that call
 * on mount (syncAlerts, web/src/lib/push/alerts.js, from both dialects), so
 * whenever the worker had registered before /settings loaded, the helm drew
 * its header and never its cards -- the blank helm #1195 recorded.
 *
 * Safari has a push service to ask, and a browser that was never subscribed
 * answers `null`. That is the answer given here, on WebKit only, so the screen
 * takes the path Safari takes for a device with alerts off; Chromium and
 * Firefox keep their own push services.
 *
 * Call before the navigation it covers: an init script runs on every later
 * document in the page.
 */
export async function answerPushWithoutAService(page: Page) {
  if (page.context().browser()?.browserType().name() !== "webkit") return;
  await page.addInitScript(() => {
    if (typeof PushManager === "undefined") return;
    PushManager.prototype.getSubscription = async () => null;
  });
}
