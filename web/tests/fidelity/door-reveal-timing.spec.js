import { expect, test } from "@playwright/test";

/*
 * THE DOOR'S FIRST LIGHT: ITS ORDER AND OFFSETS (#1253, #1515). Since the
 * owner's ruling of 2026-10-07 the door keeps orbit-site's own timing (the
 * imported door, web/src/lib/door: dawn.js and door.css), and this holds the
 * door to it:
 *
 *   · `lit` waits for the fonts and the Earth's first picture (`dawn-pre`,
 *     which sets `.world.earthy`), and on a first visit (every Playwright
 *     context is one) for at least a whole lap of the ring's running light
 *     (`body.loading`): the door is never lit before the pieces are in, and
 *     never without that lap;
 *   · `lit` starts the button and the sunrise together. The button is ready
 *     2.45s after (its 1.25s delay and 1.2s fade: door.css `.gate`); the
 *     rays are up 2.9s after (opacity .3s + 2.2s, their rise .3s + 2.6s), and
 *     the Earth's day side fades in over 2.2s after .3s, from `lit` or from
 *     its own picture arriving (`.up.in`), whichever is later.
 *
 * No clock is read (#1447). The lap is counted from the runner's own
 * `animationiteration` events, and the offsets are read from the page's
 * animation timeline: each CSS transition `lit` sets off carries its start,
 * delay and duration, and those say when it ends however busy the machine is.
 * (`page.clock` does not drive CSS transitions, so it could not stand in.)
 * It stays out of the per-merge-request `fidelity` project
 * (playwright.config.js runs it as `door-timing` in Chromium and
 * `door-timing-firefox`), as before.
 */

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/* the door as a configured instance with a provider and local sign-in
   shows it (the gate, and the local-login line under it), answered
   per page so no fixture state leaks in (as longtask measure did, #1253) */
const HEALTHY = { configured: true, phase: "running", contactAddress: null };
const DOOR = { ...HEALTHY, claimed: true, methods: { local: true, oidc: true, localAccounts: true } };
/** @param {import("@playwright/test").Route} route @param {number} status @param {unknown} body */
const answer = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/* the door's offsets after `lit`, in ms (door.css) */
const GATE = { delay: 1250, duration: 1200 };
const RAYS_OPACITY = { delay: 300, duration: 2200 };
const RAYS_RISE = { delay: 300, duration: 2600 };
const DAY_SIDE = { delay: 300, duration: 2200 };
const BUTTON_AFTER_LIT = 2450;
const SUNRISE_AFTER_LIT = 2900;

const SIZES = [
  { name: "desktop", viewport: { width: 1600, height: 1000 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
];

function installReveal() {
  /**
   * @typedef {{ who: string, property: string, start: number, delay: number, duration: number }} Run
   * @type {{ laps: number, lapsAtLit: number, loading: boolean, lit: boolean, fonts: string, earthy: boolean,
   *   inAtLit: boolean[], runs: Run[], done: boolean }}
   */
  const at = { laps: 0, lapsAtLit: -1, loading: false, lit: false, fonts: "", earthy: false, inAtLit: [], runs: [], done: false };
  /** @type {any} */ (window).__reveal = at;
  /* each lap of the ring's running light ends in an `animationiteration` on it */
  document.addEventListener("animationiteration", (e) => {
    if (e.target instanceof Element && e.target.matches(".lockup .runner")) at.laps++;
  }, true);
  /** @param {Element | null} el */
  const whoIs = (el) => !el ? ""
    : el.matches("#dawn .gate") ? "gate"
    : el.matches("#dawn .rays") ? "rays"
    : el.matches("#dawn .earth .up") ? `day ${[...document.querySelectorAll("#dawn .earth .up")].indexOf(el)}`
    : "";
  /** @type {Set<Animation>} */
  const seen = new Set();
  const tick = () => {
    const b = document.body;
    if (b && !at.lit && b.classList.contains("loading")) at.loading = true;
    if (b && !at.lit && b.classList.contains("lit")) {
      at.lit = true;
      /* what `lit` found: the fonts in, the Earth's first picture shown, and the laps run */
      at.lapsAtLit = at.laps;
      at.fonts = document.fonts.status;
      at.earthy = !!document.querySelector("#dawn .world")?.classList.contains("earthy");
      at.inAtLit = [...document.querySelectorAll("#dawn .earth .up")].map((u) => u.classList.contains("in"));
    }
    if (at.lit) {
      /* every transition on the gate, the rays and the day side, once it has a start on the timeline */
      for (const a of document.getAnimations()) {
        if (seen.has(a) || !(a instanceof CSSTransition) || a.startTime === null) continue;
        const who = whoIs(/** @type {KeyframeEffect} */ (a.effect).target);
        if (!who) continue;
        seen.add(a);
        const t = /** @type {KeyframeEffect} */ (a.effect).getTiming();
        at.runs.push({ who, property: a.transitionProperty, start: Number(a.startTime), delay: Number(t.delay), duration: Number(t.duration) });
      }
      const ups = document.querySelectorAll("#dawn .earth .up").length;
      const has = (/** @type {string} */ who, /** @type {string} */ property) => at.runs.some((r) => r.who === who && r.property === property);
      at.done = has("gate", "opacity") && has("rays", "opacity") && has("rays", "transform")
        && ups > 0 && [...Array(ups).keys()].every((i) => has(`day ${i}`, "opacity"));
    }
    if (!at.done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

for (const size of SIZES) {
  test(`door first light: the site's order and offsets, ${size.name}`, async ({ page, browserName }) => {
    test.setTimeout(40_000);
    await page.setViewportSize(size.viewport);
    await page.route("**/api/health", (r) => answer(r, 200, { status: "ready" }));
    await page.route("**/api/auth/availability", (r) => answer(r, 200, DOOR));
    await page.route("**/api/auth/session", (r) => answer(r, 401, { error: "unauthenticated" }));
    await page.addInitScript(installReveal);

    await page.goto(`${APP}/login`, { waitUntil: "load" });
    /* waited out rather than thrown, so what never came is named below
       instead of hidden behind a timeout */
    await page.waitForFunction(() => /** @type {any} */ (window).__reveal?.done, null, { timeout: 20_000 }).catch(() => {});
    const at = await page.evaluate(() => /** @type {any} */ (window).__reveal);
    console.log(`DOOR_REVEAL ${JSON.stringify({ browser: browserName, size: size.name, ...at })}`);

    expect(at.lit, "first light never came").toBe(true);
    /* `lit` waited for the fonts and the Earth's first picture */
    expect(at.fonts, "`lit` came before the fonts").toBe("loaded");
    expect(at.earthy, "`lit` came before the Earth's first picture was shown").toBe(true);
    /* and, on a first visit, for a whole lap of the runner */
    expect(at.loading, "the runner never ran").toBe(true);
    expect(at.lapsAtLit, "a first visit runs at least a lap").toBeGreaterThanOrEqual(1);
    expect(at.done, `not every transition of the reveal began: ${JSON.stringify(at.runs.map((/** @type {any} */ r) => `${r.who} ${r.property}`))}`).toBe(true);

    /** @param {string} who @param {string} property */
    const run = (who, property) => at.runs.find((/** @type {any} */ r) => r.who === who && r.property === property);
    const gate = run("gate", "opacity"), raysOpacity = run("rays", "opacity"), raysRise = run("rays", "transform");
    const days = at.runs.filter((/** @type {any} */ r) => r.who.startsWith("day ") && r.property === "opacity");
    /* `lit` set off the button and the rays together, and the day side no earlier */
    const litAt = gate.start;
    expect(raysOpacity.start, "the rays and the button start together, at `lit`").toBe(litAt);
    expect(raysRise.start, "the rays rise with the button, at `lit`").toBe(litAt);
    for (const d of days) {
      if (at.inAtLit[Number(d.who.slice(4))]) expect(d.start, `${d.who} was in at \`lit\`, so starts with it`).toBe(litAt);
      else expect(d.start, `${d.who} starts no earlier than \`lit\``).toBeGreaterThanOrEqual(litAt);
    }
    /* each one's delay and length, the door's own */
    expect({ delay: gate.delay, duration: gate.duration }, "the button: 1.25s, then a 1.2s fade").toEqual(GATE);
    expect({ delay: raysOpacity.delay, duration: raysOpacity.duration }, "the rays: .3s, then 2.2s to full").toEqual(RAYS_OPACITY);
    expect({ delay: raysRise.delay, duration: raysRise.duration }, "the rays: .3s, then a 2.6s rise").toEqual(RAYS_RISE);
    for (const d of days) expect({ delay: d.delay, duration: d.duration }, `${d.who}: .3s, then 2.2s`).toEqual(DAY_SIDE);
    /* so the order and offsets after `lit`: the button, then the sunrise */
    /* (start - litAt first: the starts are equal above, so it is exactly 0, not a float's rounding of it) */
    /** @param {any} r */
    const end = (r) => r.start - litAt + r.delay + r.duration;
    expect(end(gate), "the button is ready 2.45s after lit").toBe(BUTTON_AFTER_LIT);
    expect(Math.max(end(raysOpacity), end(raysRise)), "the rays are up 2.9s after lit").toBe(SUNRISE_AFTER_LIT);
  });
}
