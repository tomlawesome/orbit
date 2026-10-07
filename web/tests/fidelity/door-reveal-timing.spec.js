import { expect, test } from "@playwright/test";

/*
 * THE DOOR'S FIRST LIGHT, TIMED (#1253; ruling of 2026-10-06, "first light
 * rebalanced"). The owner's limits: the button ready by 2s, the whole
 * sunrise done by 3-3.5s, both from navigation.
 *
 * "Button ready" is the moment the gate can be pressed and looks it: the
 * `.gate` is in the document, `body.lit` is set and the gate's computed
 * opacity has reached 1. "Sunrise end" is the last of the rays and the
 * Earth's day side (`#dawn .earth .up`) arriving, after `lit`. Tightened
 * 2026-10-07 (flight.css): after `lit` the button is ready at about 1.05s,
 * the day side is in at about 2.5s and the rays last, at about 2.6s; with
 * `lit` at 0.4-0.7s that is the sunrise done at about 3-3.3s.
 *
 * Shaped like launch-timing.spec.js and for the same reason kept out of the
 * per-merge-request `fidelity` project (playwright.config.js runs it as
 * `door-timing` in Chromium and `door-timing-firefox`): it measures time on
 * whatever machine it is given. Everything is read inside the page, on
 * every animation frame from before the first script, so nothing the test
 * runner does in between is counted. Two runs at each size, desktop and
 * phone.
 */

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/* the door as a configured instance with a provider and local sign-in
   shows it (the gate, and the local-login line under it), answered
   per page so no fixture state leaks in (as longtask measure did, #1253) */
const HEALTHY = { configured: true, phase: "running", contactAddress: null };
const DOOR = { ...HEALTHY, claimed: true, methods: { local: true, oidc: true, localAccounts: true } };
/** @param {import("@playwright/test").Route} route @param {number} status @param {unknown} body */
const answer = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const SIZES = [
  { name: "desktop", viewport: { width: 1600, height: 1000 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];

function installReveal() {
  /** @type {{ lit: number, button: number, sunrise: number }} */
  const at = { lit: 0, button: 0, sunrise: 0 };
  /** @type {any} */ (window).__reveal = at;
  /** @param {Element | null} el */
  const opacity = (el) => (el ? Number(getComputedStyle(el).opacity) : 0);
  const tick = () => {
    const t = performance.now();
    const b = document.body;
    if (b && !at.lit && b.classList.contains("lit")) at.lit = t;
    if (at.lit && !at.button && opacity(document.querySelector(".gate")) >= 1) at.button = t;
    if (at.lit && !at.sunrise) {
      const rays = document.querySelector("#dawn .rays");
      const ups = [...document.querySelectorAll("#dawn .earth .up")];
      const raysDone = rays && opacity(rays) >= 1 && getComputedStyle(rays).transform.replace(/\s/g, "") === "matrix(1,0,0,1,0,0)";
      const dayDone = ups.length > 0 && ups.every((u) => u.classList.contains("in") && opacity(u) >= 1);
      if (raysDone && dayDone) at.sunrise = t;
    }
    if (!at.sunrise || !at.button) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

for (const size of SIZES) {
  for (const run of [1, 2]) {
    test(`door first light — ${size.name}, run ${run}`, async ({ page, browserName }) => {
      test.setTimeout(30_000);
      await page.setViewportSize(size.viewport);
      await page.route("**/api/health", (r) => answer(r, 200, { status: "ready" }));
      await page.route("**/api/auth/availability", (r) => answer(r, 200, DOOR));
      await page.route("**/api/auth/session", (r) => answer(r, 401, { error: "unauthenticated" }));
      await page.addInitScript(installReveal);

      await page.goto(`${APP}/login`, { waitUntil: "load" });
      /* waited out rather than thrown, so a moment that never comes is
         named below instead of hidden behind a timeout */
      await page.waitForFunction(() => {
        const at = /** @type {any} */ (window).__reveal;
        return at && at.button && at.sunrise;
      }, null, { timeout: 15_000 }).catch(() => {});
      const at = await page.evaluate(() => /** @type {any} */ (window).__reveal);
      if (!at.button || !at.sunrise) {
        const seen = await page.evaluate(() => {
          const g = document.querySelector(".gate"), r = document.querySelector("#dawn .rays");
          return {
            body: document.body.className, state: document.body.dataset.state ?? null,
            gate: g ? getComputedStyle(g).opacity : "absent",
            rays: r ? `${getComputedStyle(r).opacity} ${getComputedStyle(r).transform}` : "absent",
            day: [...document.querySelectorAll("#dawn .earth .up")].map((u) => `${u.getAttribute("class")} ${getComputedStyle(u).opacity}`),
          };
        });
        console.log(`DOOR_TIMING incomplete ${JSON.stringify({ at, seen })}`);
      }
      const ms = { lit: Math.round(at.lit), button: Math.round(at.button), sunrise: Math.round(at.sunrise) };
      console.log(`DOOR_TIMING ${JSON.stringify({ browser: browserName, size: size.name, run, ...ms })}`);

      expect(ms.button, "the button never became ready").toBeGreaterThan(0);
      expect(ms.sunrise, "the sunrise never ended").toBeGreaterThan(0);
      expect(ms.button, "the button is ready by 2s").toBeLessThanOrEqual(2000);
      expect(ms.sunrise, "the sunrise ends by 3.5s").toBeLessThanOrEqual(3500);
      expect(ms.sunrise, "the sunrise takes 3s at least").toBeGreaterThanOrEqual(3000);
    });
  }
}
