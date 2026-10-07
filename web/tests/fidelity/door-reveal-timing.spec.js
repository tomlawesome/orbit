import { expect, test } from "@playwright/test";

/*
 * THE DOOR'S FIRST LIGHT, TIMED (#1253). Since the owner's ruling of
 * 2026-10-07 the door keeps orbit-site's own timing (first-light.js, ported
 * from the site's main.js `showDoor`), and the 2026-10-06 limits (button by
 * 2s, sunrise by 3-3.5s from navigation) are withdrawn.
 *
 * What is held now is the site's ORDER and its OFFSETS FROM `lit`:
 *
 *   · `lit` waits for the fonts and the Earth's first picture (`dawn-pre`),
 *     and on a first visit (every Playwright context is one) for a whole lap
 *     of the ring's running light, `body.loading`, about 1.8s: the door is
 *     never lit before the pieces are in, and never without that lap;
 *   · after `lit` the button is ready at about 2.45s (its 1.25s delay and
 *     1.2s fade) and the sunrise is done at about 4.8s (the Earth's day side,
 *     4.5s after .3s; the rays end at 4.4s), each give or take OFFSET_GIVE.
 *
 * "Button ready" is the moment the gate can be pressed and looks it: the
 * `.gate` is in the document, `body.lit` is set and the gate's computed
 * opacity has reached 1. "Sunrise end" is the last of the rays and the
 * Earth's day side (`#dawn .earth .up`) arriving, after `lit`.
 *
 * Shaped like launch-timing.spec.js and for the same reason kept out of the
 * per-merge-request `fidelity` project (playwright.config.js runs it as
 * `door-timing` in Chromium and `door-timing-firefox`): it measures time on
 * whatever machine it is given. Everything is read inside the page, on
 * every animation frame from before the first script, so nothing the test
 * runner does in between is counted. Two runs at each size, desktop and
 * phone. (The late-page runs, which held the page's code back to prove
 * first light caught up with a clock, went with the clock.)
 */

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/* the door as a configured instance with a provider and local sign-in
   shows it (the gate, and the local-login line under it), answered
   per page so no fixture state leaks in (as longtask measure did, #1253) */
const HEALTHY = { configured: true, phase: "running", contactAddress: null };
const DOOR = { ...HEALTHY, claimed: true, methods: { local: true, oidc: true, localAccounts: true } };
/** @param {import("@playwright/test").Route} route @param {number} status @param {unknown} body */
const answer = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/* the site's offsets after `lit` (site.css: gate 1.25s + 1.2s; Earth .3s + 4.5s) */
const BUTTON_AFTER_LIT = 2450;
const SUNRISE_AFTER_LIT = 4800;
const OFFSET_GIVE = 250;
/* one lap of the runner (site.css: `runner 1.8s`), the least `loading` lasts on a first visit */
const LAP_MS = 1800;

const SIZES = [
  { name: "desktop", viewport: { width: 1600, height: 1000 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];

function installReveal() {
  /** @type {{ loading: number, lit: number, button: number, sunrise: number, fonts: string, earth: string, earthy: boolean }} */
  const at = { loading: 0, lit: 0, button: 0, sunrise: 0, fonts: "", earth: "", earthy: false };
  /** @type {any} */ (window).__reveal = at;
  /** @param {Element | null} el */
  const opacity = (el) => (el ? Number(getComputedStyle(el).opacity) : 0);
  const tick = () => {
    const t = performance.now();
    const b = document.body;
    if (b && !at.loading && b.classList.contains("loading")) at.loading = t;
    if (b && !at.lit && b.classList.contains("lit")) {
      at.lit = t;
      /* what `lit` found: the fonts in, and the Earth's first picture settled and shown */
      const world = document.querySelector("#dawn .world");
      at.fonts = document.fonts.status;
      at.earth = /** @type {HTMLElement | null} */ (world)?.dataset.earth ?? "";
      at.earthy = !!world?.classList.contains("earthy");
    }
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

const RUNS = SIZES.flatMap((size) => [1, 2].map((run) => ({ size, run })));

for (const { size, run } of RUNS) {
  test(`door first light: the site's order and offsets, ${size.name}, run ${run}`, async ({ page, browserName }) => {
    test.setTimeout(40_000);
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
    }, null, { timeout: 25_000 }).catch(() => {});
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
    const ms = {
      loading: Math.round(at.loading), lit: Math.round(at.lit), button: Math.round(at.button), sunrise: Math.round(at.sunrise),
      buttonAfterLit: Math.round(at.button - at.lit), sunriseAfterLit: Math.round(at.sunrise - at.lit),
      loadingFor: Math.round(at.lit - at.loading),
    };
    console.log(`DOOR_TIMING ${JSON.stringify({ browser: browserName, size: size.name, run, ...ms, fonts: at.fonts, earth: at.earth })}`);

    expect(at.lit, "first light never came").toBeGreaterThan(0);
    /* `lit` waited for the fonts and the Earth's first picture */
    expect(at.fonts, "`lit` came before the fonts").toBe("loaded");
    expect(at.earth, "`lit` came before the Earth's first picture").toBe("settled");
    expect(at.earthy, "`lit` came before the Earth's first picture was shown").toBe(true);
    /* and, on a first visit, for a whole lap of the runner */
    expect(at.loading, "the runner never ran").toBeGreaterThan(0);
    expect(at.lit - at.loading, "a first visit runs at least a lap").toBeGreaterThanOrEqual(LAP_MS - 100);
    /* the site's order and offsets after `lit` */
    expect(at.button, "the button never became ready").toBeGreaterThan(at.lit);
    expect(at.sunrise, "the sunrise never ended").toBeGreaterThan(at.button);
    expect(Math.abs(at.button - at.lit - BUTTON_AFTER_LIT), "the button is ready about 2.45s after lit").toBeLessThanOrEqual(OFFSET_GIVE);
    expect(Math.abs(at.sunrise - at.lit - SUNRISE_AFTER_LIT), "the sunrise ends about 4.8s after lit").toBeLessThanOrEqual(OFFSET_GIVE);
  });
}
